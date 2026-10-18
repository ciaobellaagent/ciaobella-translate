import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { MODEL, DEFAULT_EFFORT } from './codex.mjs';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function validateInput(body, { model = MODEL, effort = DEFAULT_EFFORT } = {}) {
  const { text_list: texts, target_lang: target = 'zh-CN', source_lang: source = 'auto' } = body || {};
  if ((body?.model && body.model !== model) || (body?.effort && body.effort !== effort)) {
    throw new HttpError(400, '请求与当前模型或推理强度设置不同，请刷新扩展；请从设置页切换。');
  }
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > 24 ||
      texts.some(text => typeof text !== 'string' || !text.trim() || text.length > 14000) ||
      texts.reduce((n, text) => n + text.length, 0) > 16000) {
    throw new HttpError(400, '每次需提供 1–24 个非空段落，单段最多 14000 字符，合计最多 16000 字符。');
  }
  for (const lang of [target, source]) {
    if (typeof lang !== 'string' || !/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{2,8}){0,2}$/.test(lang)) {
      throw new HttpError(400, '语言代码无效。');
    }
  }
  return { texts, target, source };
}

function placeholders(text) {
  return (text.match(/\{\{[^{}\n]+\}\}|\{\d+\}|__[^\s]+?__|<\/?[a-zA-Z]+\d+\s*\/?\s*>/g) || []).sort();
}

export class TranslationService {
  constructor(translator, { runtime, maxCache = 10000, maxBytes = 32 * 1024 * 1024, cacheDays = 30, supplementalPrompt = '', model = MODEL, effort = DEFAULT_EFFORT, concurrency = 12, now = Date.now } = {}) {
    this.translator = translator;
    this.runtime = runtime;
    this.maxCache = maxCache;
    this.maxBytes = maxBytes;
    this.now = now;
    this.ttl = cacheDays * 86400000;
    this.supplementalPrompt = supplementalPrompt;
    this.model = model;
    this.effort = effort;
    this.generation = 0;
    this.cache = new Map();
    this.cacheBytes = 128;
    this.dirty = false;
    this.saveTimer = null;
    this.saveTail = Promise.resolve();
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
    this.inflight = new Map();
    this.backoffUntil = 0;
    this.backoffLimit = concurrency;
    this.pending = 0;
    this.requests = 0;
    this.cacheHits = 0;
  }

  async load() {
    if (!this.runtime) return;
    this.loading = true;
    try {
      const entries = JSON.parse(await readFile(join(this.runtime, 'cache.json'), 'utf8'));
      if ((entries.version === 2 || (entries.model === MODEL && entries.version === 1)) && Array.isArray(entries.items)) {
        for (const [key, value] of entries.items.slice(-this.maxCache)) {
          if (/^[a-f0-9]{64}$/.test(key) && this.valid(value)) this.store(key, value);
        }
      }
    } catch { /* absent or invalid cache is disposable */ }
    finally { this.loading = false; }
  }

  key(text, target, source, prompt = this.supplementalPrompt, model = this.model, effort = this.effort) {
    // Legacy entries were generated with Luna+low. Only that exact combination
    // can reuse their keys; every other model/effort has its own namespace.
    const context = model === MODEL && effort === 'low'
      ? prompt ? ['v2', MODEL, target, source, text, prompt] : ['v1', MODEL, target, source, text]
      : ['v3', model, effort, target, source, text, prompt];
    return createHash('sha256').update(JSON.stringify(context)).digest('hex');
  }

  setSettings({ supplementalPrompt = this.supplementalPrompt, model = this.model, effort = this.effort, cacheDays = this.ttl / 86400000, cacheMaxBytes = this.maxBytes, concurrency = this.concurrency } = {}) {
    this.supplementalPrompt = supplementalPrompt;
    this.model = model;
    this.effort = effort;
    this.ttl = cacheDays * 86400000;
    this.maxBytes = cacheMaxBytes;
    this.concurrency = concurrency;
    this.drain();
    for (const [key, entry] of this.cache) if (!this.valid(entry)) this.remove(key);
    while (this.cache.size > this.maxCache || this.cacheBytes > this.maxBytes) this.remove(this.cache.keys().next().value);
  }

  async clearCache() {
    this.generation++;
    this.cache.clear(); this.cacheBytes = 128;
    this.changed();
    await this.flush();
  }

  valid(entry) {
    return typeof entry?.text === 'string' && entry.text.trim() && Number.isFinite(entry.at) &&
      entry.at <= this.now() && this.now() - entry.at < this.ttl;
  }

  size(key, entry) { return Buffer.byteLength(JSON.stringify([key, entry])) + 1; }

  remove(key) {
    const entry = this.cache.get(key);
    if (entry) { this.cacheBytes -= this.size(key, entry); this.cache.delete(key); this.changed(); }
  }

  store(key, entry) {
    this.remove(key);
    const size = this.size(key, entry);
    if (size + 128 > this.maxBytes) return;
    this.cache.set(key, entry); this.cacheBytes += size;
    this.changed();
    while (this.cache.size > this.maxCache || this.cacheBytes > this.maxBytes) this.remove(this.cache.keys().next().value);
  }

  read(key) {
    const entry = this.cache.get(key);
    if (!this.valid(entry)) { this.remove(key); return null; }
    // Refresh recency without extending the 30-day translation age.
    this.cache.delete(key); this.cache.set(key, entry);
    this.changed();
    return entry;
  }

  changed() {
    if (this.loading || !this.runtime) return;
    this.dirty = true;
    if (!this.saveTimer) {
      // Read-only LRU bookkeeping does not justify rewriting the complete cache
      // every minute. New translations and explicit settings still await flush.
      this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush().catch(() => {}); }, 15 * 60000);
      this.saveTimer.unref();
    }
  }

  async flush() {
    clearTimeout(this.saveTimer); this.saveTimer = null;
    if (!this.runtime || !this.dirty) return this.saveTail;
    const path = join(this.runtime, 'cache.json');
    const task = this.saveTail.catch(() => {}).then(async () => {
      // Serialize only when the preceding disk write has completed. Overlapping
      // flush callers share the newest state rather than retaining full copies.
      if (!this.dirty) return;
      this.dirty = false;
      try {
        const data = JSON.stringify({ version: 2, items: [...this.cache] });
        await writeFile(`${path}.tmp`, data, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      } catch (error) { this.dirty = true; throw error; }
    });
    this.saveTail = task;
    return task;
  }

  cached({ texts, target, source, prompt = this.supplementalPrompt, model = this.model, effort = this.effort }) {
    const translations = texts.map(text => {
      const entry = this.read(this.key(text, target, source, prompt, model, effort));
      return entry ? { text: entry.text, detected_source_lang: source } : null;
    });
    return { translations, model, effort, cached: translations.filter(Boolean).length, elapsed_ms: 0 };
  }

  lookup(body) {
    const result = this.cached(validateInput(body, this));
    this.cacheHits += result.cached;
    return result;
  }

  get effectiveConcurrency() {
    return this.now() < this.backoffUntil ? Math.min(this.concurrency, this.backoffLimit) : this.concurrency;
  }

  drain() {
    while (this.active < this.effectiveConcurrency && this.queue.length) {
      this.queue.sort((a, b) => a.priority - b.priority);
      const job = this.queue.shift();
      job.signal?.removeEventListener('abort', job.cancel);
      this.active++;
      this.run(job.input).then(job.resolve, error => {
        if (/429|rate.?limit|quota|usage.?limit|timeout|timed? out|超时/i.test(error.message)) {
          this.backoffLimit = Math.max(1, Math.floor(this.effectiveConcurrency / 2));
          this.backoffUntil = this.now() + 30000;
          clearTimeout(this.backoffTimer);
          this.backoffTimer = setTimeout(() => this.drain(), 30010);
          this.backoffTimer.unref?.();
        }
        job.reject(error);
      }).finally(() => { this.active--; this.pending--; this.drain(); });
    }
  }

  async translate(body, { signal, priority = 0 } = {}) {
    const input = { ...validateInput(body, this), model: this.model, effort: this.effort, prompt: this.supplementalPrompt, generation: this.generation };
    if (signal?.aborted) throw new HttpError(499, '翻译已取消。');
    const cached = this.cached(input);
    if (cached.cached === input.texts.length) {
      this.cacheHits += cached.cached;
      return cached;
    }
    if (this.pending >= 128) throw new HttpError(429, '翻译队列已满，请稍后重试。');
    this.pending++;
    return new Promise((resolve, reject) => {
      const job = { input, resolve, reject, signal, priority: priority === 1 ? 1 : 0 };
      job.cancel = () => {
        const index = this.queue.indexOf(job);
        if (index < 0) return; // Running inference may finish and populate cache.
        this.queue.splice(index, 1); this.pending--;
        reject(new HttpError(499, '翻译已取消。'));
      };
      signal?.addEventListener('abort', job.cancel, { once: true });
      this.queue.push(job); this.drain();
    });
  }

  async run({ texts, target, source, model = this.model, effort = this.effort, prompt = this.supplementalPrompt, generation = this.generation }) {
    const started = this.now();
    const keys = texts.map(text => this.key(text, target, source, prompt, model, effort));
    let hits = 0;
    const missing = new Map();
    const results = new Map();
    keys.forEach((key, index) => {
      const entry = this.read(key);
      if (entry) { hits++; results.set(key, entry.text); }
      else missing.set(key, texts[index]);
    });
    const owned = new Map(), waits = [];
    for (const [key, text] of missing) {
      const flightKey = `${generation}:${key}`;
      let flight = this.inflight.get(flightKey);
      if (!flight) {
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        flight = { promise, resolve, reject, flightKey };
        this.inflight.set(flightKey, flight); owned.set(key, { text, ...flight });
      }
      waits.push(flight.promise.then(text => results.set(key, text)));
    }
    // Attach rejection handlers before invoking the provider. Overlapping callers
    // share fragment promises, including failures, without leaking rejected promises.
    const completed = Promise.all(waits);
    const produce = async () => {
      if (!owned.size) return;
      try {
        const values = [...owned.values()].map(item => item.text);
        this.requests++;
        const translated = await this.translator.translate(values, target, source, prompt, { model, effort });
        if (!Array.isArray(translated) || translated.length !== values.length) throw new Error('翻译数量不匹配。');
        translated.forEach((text, index) => {
          if (typeof text !== 'string' || !text.trim()) throw new Error('翻译包含空段落。');
          if (JSON.stringify(placeholders(values[index])) !== JSON.stringify(placeholders(text))) throw new Error('译文占位符缺失或改变，已停止显示；请重试。');
        });
        [...owned].forEach(([key, entry], index) => {
          if (generation === this.generation) this.store(key, { text: translated[index], at: this.now() });
          entry.resolve(translated[index]);
        });
      } catch (error) {
        for (const entry of owned.values()) entry.reject(error);
      } finally {
        for (const entry of owned.values()) this.inflight.delete(entry.flightKey);
      }
    };
    const outcomes = await Promise.allSettled([completed, produce()]);
    const failed = outcomes.find(item => item.status === 'rejected');
    if (failed) throw failed.reason;
    // Request-local results survive eviction while other pages perform lookups.
    const translations = keys.map(key => ({ text: results.get(key), detected_source_lang: source }));
    if (missing.size && this.runtime) await this.flush();
    this.cacheHits += hits;
    return { translations, model, effort, cached: hits, elapsed_ms: this.now() - started };
  }
}
