import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { MODEL, DEFAULT_EFFORT, EFFORTS, INSTRUCTIONS } from './codex.mjs';

export const DEFAULT_SETTINGS = Object.freeze({ model: MODEL, effort: DEFAULT_EFFORT, supplementalPrompt: '', cacheDays: 30, cacheMaxBytes: 32 * 1024 * 1024 });
const fields = new Set(Object.keys(DEFAULT_SETTINGS));

export function promptRevision(prompt = '', model = MODEL, effort = DEFAULT_EFFORT) {
  return createHash('sha256').update(JSON.stringify(['v2', model, effort, INSTRUCTIONS, prompt])).digest('hex');
}

export function validateSettings(patch) {
  const invalid = message => { const error = new Error(message); error.status = 400; throw error; };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) invalid('设置必须是 JSON 对象。');
  if (Object.keys(patch).some(key => !fields.has(key))) invalid('设置包含未知字段。');
  if ('model' in patch && (typeof patch.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(patch.model))) invalid('模型标识无效。');
  if ('effort' in patch && !EFFORTS.has(patch.effort)) invalid('推理强度无效。');
  if ('supplementalPrompt' in patch && (typeof patch.supplementalPrompt !== 'string' || [...patch.supplementalPrompt].length > 4000)) {
    invalid('补充翻译 Prompt 最多 4000 个字符。');
  }
  if ('cacheDays' in patch && ![7, 30, 90].includes(patch.cacheDays)) invalid('缓存期限仅支持 7、30 或 90 天。');
  if ('cacheMaxBytes' in patch && ![8, 16, 32].map(n => n * 1024 * 1024).includes(patch.cacheMaxBytes)) {
    invalid('缓存容量仅支持 8、16 或 32 MiB。');
  }
  return { ...patch };
}

export class SettingsStore {
  constructor({ runtime } = {}) {
    this.runtime = runtime;
    this.values = { ...DEFAULT_SETTINGS };
    this.tail = Promise.resolve();
  }

  async load() {
    if (!this.runtime) return this.read();
    try {
      const stored = JSON.parse(await readFile(join(this.runtime, 'settings.json'), 'utf8'));
      if ([1, 2].includes(stored.version)) this.values = { ...DEFAULT_SETTINGS, ...validateSettings(stored.settings) };
    } catch { /* Missing or invalid settings fall back to bounded defaults. */ }
    return this.read();
  }

  read() {
    return { ...this.values, modelEditable: true, basePrompt: INSTRUCTIONS,
      promptRevision: promptRevision(this.values.supplementalPrompt, this.values.model, this.values.effort) };
  }

  update(patch, { validate } = {}) {
    const checked = validateSettings(patch);
    const task = this.tail.catch(() => {}).then(async () => {
      const values = { ...this.values, ...checked };
      if (validate) await validate(values);
      if (this.runtime) {
        await mkdir(this.runtime, { recursive: true, mode: 0o700 });
        const path = join(this.runtime, 'settings.json');
        const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
        await writeFile(temporary, JSON.stringify({ version: 2, settings: values }), { mode: 0o600 });
        await rename(temporary, path);
      }
      this.values = values;
      return this.read();
    });
    this.tail = task;
    return task;
  }
}
