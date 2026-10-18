import test from 'node:test';
import assert from 'node:assert/strict';
import { TranslationService, validateInput } from '../bridge/translate.mjs';

test('invalid batches and per-request overrides of the selected model are rejected before inference', () => {
  for (const body of [{}, { text_list: [] }, { text_list: [''] }, { text_list: ['x'], model: 'gpt-6-sol' },
    { text_list: Array(25).fill('test') }, { text_list: ['x'.repeat(14001)] },
    { text_list: ['text'], target_lang: 'zh-CN\nignore' }]) assert.throws(() => validateInput(body));
  assert.equal(validateInput({ text_list: ['example'] }).target, 'zh-CN');
});

test('deduplicates source text, preserves order and caches by language', async () => {
  const calls = [];
  const service = new TranslationService({ translate: async (texts, target) => { calls.push(texts); return texts.map(x => target + x); } });
  const first = await service.translate({ text_list: ['first', 'second', 'first'] });
  assert.deepEqual(first.translations.map(x => x.text), ['zh-CNfirst', 'zh-CNsecond', 'zh-CNfirst']);
  assert.deepEqual(calls, [['first', 'second']]);
  assert.equal((await service.translate({ text_list: ['first'] })).cached, 1);
  await service.translate({ text_list: ['first'], target_lang: 'ja' });
  assert.equal(calls.length, 2);
});

test('concurrent identical batches share one inference', async () => {
  let calls = 0;
  const service = new TranslationService({ translate: async texts => { calls++; await new Promise(r => setTimeout(r, 15)); return texts; } });
  await Promise.all([service.translate({ text_list: ['same'] }), service.translate({ text_list: ['same'] })]);
  assert.equal(calls, 1);
});

test('errors never cache or downgrade; the next request can recover', async () => {
  let calls = 0;
  const service = new TranslationService({ translate: async texts => { if (++calls === 1) throw new Error('usage limit exceeded'); return texts; } });
  await assert.rejects(service.translate({ text_list: ['sample'] }), /usage limit/);
  assert.equal(service.cache.size, 0);
  await service.translate({ text_list: ['sample'] }); assert.equal(calls, 2);
});

test('missing placeholders fail the whole batch without caching partial results', async () => {
  const service = new TranslationService({ translate: async () => ['good', 'translation'] });
  await assert.rejects(service.translate({ text_list: ['good', 'Hello {0} <b1></b1>'] }), /占位符/);
  assert.equal(service.cache.size, 0);
});

test('a batch survives bounded cache eviction', async () => {
  const service = new TranslationService({ translate: async texts => texts }, { maxCache: 1 });
  const result = await service.translate({ text_list: ['first', 'second'] });
  assert.equal(result.translations.length, 2); assert.equal(service.cache.size, 1);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function controlledService(options) {
  const calls = [], releases = [];
  const service = new TranslationService({ translate: texts => {
    calls.push(texts);
    return new Promise((resolve, reject) => releases.push({ resolve: () => resolve(texts), reject }));
  } }, options);
  return { service, calls, releases };
}

test('global pool enforces limit, expands live and prioritizes visible queued work', async () => {
  const { service, calls, releases } = controlledService({ concurrency: 1 });
  const first = service.translate({ text_list: ['first'] });
  const prefetch = service.translate({ text_list: ['prefetch'] }, { priority: 1 });
  const visible = service.translate({ text_list: ['visible'] }, { priority: 0 });
  assert.deepEqual(calls, [['first']]); assert.equal(service.pending, 3);
  service.setSettings({ concurrency: 2 });
  assert.deepEqual(calls, [['first'], ['visible']]);
  service.setSettings({ concurrency: 1 });
  releases[0].resolve(); await first; await tick();
  assert.equal(calls.length, 2, 'Lowering the limit waits for existing work');
  releases[1].resolve(); await visible; await tick();
  assert.deepEqual(calls[2], ['prefetch']); releases[2].resolve(); await prefetch; await tick();
  assert.equal(service.active, 0); assert.equal(service.pending, 0);
});

test('overlapping parallel batches share fragment inference and retain output order', async () => {
  const { service, calls, releases } = controlledService({ concurrency: 3 });
  const a = service.translate({ text_list: ['one', 'shared'] });
  const b = service.translate({ text_list: ['shared', 'two', 'shared'] });
  const c = service.translate({ text_list: ['shared'] });
  assert.deepEqual(calls, [['one', 'shared'], ['two']]);
  releases[1].resolve(); releases[0].resolve();
  const results = await Promise.all([a, b, c]);
  assert.deepEqual(results[1].translations.map(item => item.text), ['shared', 'two', 'shared']);
  assert.equal(service.inflight.size, 0);
});

test('shared inference failure rejects all waiters and releases keys for retry', async () => {
  const { service, calls, releases } = controlledService({ concurrency: 2 });
  const a = service.translate({ text_list: ['shared'] }), b = service.translate({ text_list: ['shared'] });
  const done = Promise.allSettled([a, b]); releases[0].reject(Error('provider failed'));
  assert((await done).every(item => item.status === 'rejected'));
  assert.equal(service.inflight.size, 0); assert.equal(service.cache.size, 0);
  const retry = service.translate({ text_list: ['shared'] });
  await tick(); assert.equal(calls.length, 2); releases[1].resolve(); await retry;
});

test('queued cancellation consumes no inference and cache bypasses an occupied pool', async () => {
  const { service, calls, releases } = controlledService({ concurrency: 1 });
  service.store(service.key('cached', 'zh-CN', 'auto'), { text: 'hit', at: Date.now() });
  const a = service.translate({ text_list: ['busy'] });
  const controller = new AbortController();
  const b = service.translate({ text_list: ['cancel me'] }, { signal: controller.signal });
  const rejected = assert.rejects(b, /取消/); controller.abort(); await rejected;
  assert.equal((await service.translate({ text_list: ['cached'] })).cached, 1);
  releases[0].resolve(); await a; await tick();
  assert.deepEqual(calls, [['busy']]); assert.equal(service.pending, 0);
});

test('cache clearing prevents a new generation from joining stale in-flight work', async () => {
  const { service, calls, releases } = controlledService({ concurrency: 2 });
  const a = service.translate({ text_list: ['shared'] }); await service.clearCache();
  const b = service.translate({ text_list: ['shared'] }); assert.equal(calls.length, 2);
  releases[0].resolve(); await a; assert.equal(service.cache.size, 0);
  releases[1].resolve(); await b; assert.equal(service.cache.size, 1);
});

test('a failed shared fragment never releases a slot while its sibling inference is running', async () => {
  let active = 0, peak = 0;
  const releases = [];
  const service = new TranslationService({ translate: texts => {
    active++; peak = Math.max(peak, active);
    return new Promise((resolve, reject) => releases.push({
      resolve: () => { active--; resolve(texts); }, reject: () => { active--; reject(Error('failed shared fragment')); },
    }));
  } }, { concurrency: 2 });
  const a = service.translate({ text_list: ['x'] });
  const b = service.translate({ text_list: ['x', 'y'] });
  const c = service.translate({ text_list: ['z'] });
  const d = service.translate({ text_list: ['w'] });
  const done = Promise.allSettled([a, b, c, d]);
  releases[0].reject(); await tick();
  assert.equal(releases.length, 3); assert.equal(active, 2);
  releases[2].resolve(); await tick();
  assert.equal(peak, 2); releases[1].resolve(); releases[3].resolve();
  assert.deepEqual((await done).map(item => item.status), ['rejected', 'rejected', 'fulfilled', 'fulfilled']);
});

test('provider throttling reduces the effective limit temporarily without changing user preference', async () => {
  let now = 1000;
  const service = new TranslationService({ translate: async () => { throw Error('429 rate limit'); } }, { concurrency: 12, now: () => now });
  await assert.rejects(service.translate({ text_list: ['source'] }), /429/);
  assert.equal(service.concurrency, 12); assert.equal(service.effectiveConcurrency, 6);
  now += 30001; assert.equal(service.effectiveConcurrency, 12);
  clearTimeout(service.backoffTimer);
});
