import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodexTranslator, MODEL, DEFAULT_EFFORT, normalizeModels, assertModelChoice } from '../bridge/codex.mjs';
import { SettingsStore } from '../bridge/settings.mjs';
import { TranslationService } from '../bridge/translate.mjs';

const entry = (model, efforts = ['low', 'medium', 'high']) => ({ model, displayName: model,
  defaultReasoningEffort: 'medium', supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) });

test('model catalog preserves actual effort bounds and excludes hidden, non-text, and agent-only modes', () => {
  const catalog = normalizeModels([entry(MODEL, ['low', 'medium', 'max', 'ultra']),
    { ...entry('hidden'), hidden: true }, { ...entry('image-model'), inputModalities: ['image'] }, entry('bad\nmodel')]);
  assert.deepEqual(catalog, [{ model: MODEL, name: MODEL, efforts: ['low', 'medium', 'max'], defaultEffort: 'medium' }]);
  assertModelChoice(catalog, MODEL, 'medium');
  for (const [model, effort] of [[MODEL, 'ultra'], ['unknown', 'medium'], [MODEL, 'high']]) {
    assert.throws(() => assertModelChoice(catalog, model, effort), error => error.status === 400);
  }
});

test('catalog paginates and refreshes explicitly without inference', async () => {
  const c = new CodexTranslator(); c.ready = Promise.resolve();
  const calls = [];
  c.rpc = async (method, params) => {
    assert.equal(method, 'model/list'); calls.push(params);
    return params.cursor ? { data: [entry('gpt-6-sol')], nextCursor: null } : { data: [entry(MODEL)], nextCursor: 'next' };
  };
  assert.equal((await c.models()).length, 2); assert.equal(calls.length, 2);
  await c.models(); assert.equal(calls.length, 2);
  await c.models({ refresh: true }); assert.equal(calls.length, 4);
});

test('selected model and effort reach both thread and turn; mismatches never fall back', async () => {
  const c = new CodexTranslator(); c.ready = Promise.resolve();
  const calls = []; let mismatch = false;
  c.rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'config/read') return { config: {} };
    if (method === 'model/list') return { data: [entry(MODEL), entry('gpt-6-sol')] };
    if (method === 'thread/start') return { model: mismatch ? MODEL : params.model, modelProvider: 'openai', thread: { id: 'thread' } };
    if (method === 'turn/start') {
      c.turns.get('thread').text = JSON.stringify({ translations: [{ id: 0, text: '译文' }] });
      queueMicrotask(() => c.onMessage({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } }));
      return { turn: { id: 'turn' } };
    }
    return {};
  };
  assert.deepEqual(await c.translate(['source'], 'zh-CN', 'auto', '', { model: 'gpt-6-sol', effort: 'high' }), ['译文']);
  const thread = calls.find(c => c.method === 'thread/start').params, turn = calls.find(c => c.method === 'turn/start').params;
  assert.equal(thread.model, 'gpt-6-sol'); assert.equal(thread.allowProviderModelFallback, false);
  assert.equal(thread.config.model_reasoning_effort, 'high'); assert.equal(turn.model, 'gpt-6-sol'); assert.equal(turn.effort, 'high');
  mismatch = true;
  await assert.rejects(c.translate(['source'], 'zh-CN', 'auto', '', { model: 'gpt-6-sol', effort: 'medium' }), /不匹配/);
  assert.equal(calls.filter(c => c.method === 'turn/start').length, 1);
  await assert.rejects(c.translate(['source'], 'zh-CN', 'auto', '', { model: 'unknown', effort: 'medium' }), /未提供/);
  assert.equal(calls.filter(c => c.method === 'thread/start').length, 2);
});

test('model and effort isolate caches and queued batches retain their submitted configuration', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { started = resolve; });
  const calls = [];
  const service = new TranslationService({ translate: async (texts, target, source, prompt, choice) => {
    calls.push(choice); if (calls.length === 1) { started(); await gate; }
    return texts.map(text => `${choice.model}:${choice.effort}:${text}`);
  } });
  assert.equal(service.effort, 'medium');
  const first = service.translate({ text_list: ['same'] }); await ready;
  service.setSettings({ model: 'gpt-6-sol', effort: 'high' });
  const second = service.translate({ text_list: ['same'] });
  service.setSettings({ model: MODEL, effort: 'low' });
  release();
  assert.equal((await first).model, MODEL); assert.equal((await second).model, 'gpt-6-sol');
  assert.deepEqual(calls, [{ model: MODEL, effort: 'medium' }, { model: 'gpt-6-sol', effort: 'high' }]);
  assert.equal(service.lookup({ text_list: ['same'] }).cached, 0);
  service.setSettings({ effort: 'medium' }); assert.equal(service.lookup({ text_list: ['same'] }).cached, 1);
  service.setSettings({ model: 'gpt-6-sol', effort: 'high' }); assert.equal(service.lookup({ text_list: ['same'] }).cached, 1);
});

test('legacy low cache imports without being reused as medium; old settings migrate to medium', async t => {
  const runtime = await mkdtemp(join(tmpdir(), 'bella-migration-')); t.after(() => rm(runtime, { recursive: true, force: true }));
  const key = createHash('sha256').update(JSON.stringify(['v1', MODEL, 'zh-CN', 'auto', 'original'])).digest('hex');
  await writeFile(join(runtime, 'cache.json'), JSON.stringify({ version: 1, model: MODEL, items: [[key, { text: 'old low translation', at: Date.now() }]] }));
  await writeFile(join(runtime, 'settings.json'), JSON.stringify({ version: 1, settings: { supplementalPrompt: 'Keep names', cacheDays: 7, cacheMaxBytes: 8 * 1048576 } }));
  const settings = new SettingsStore({ runtime }); await settings.load();
  assert.equal(settings.read().effort, DEFAULT_EFFORT); assert.equal(settings.read().supplementalPrompt, 'Keep names');
  const service = new TranslationService({}, { runtime }); await service.load();
  assert.equal(service.cache.size, 1); assert.equal(service.lookup({ text_list: ['original'] }).cached, 0);
  service.setSettings({ effort: 'low' }); assert.equal(service.lookup({ text_list: ['original'] }).cached, 1);
  await service.flush(); assert.equal(JSON.parse(await readFile(join(runtime, 'cache.json'))).version, 2);
});

test('settings validate the merged pair inside the serialized write and revision tracks effort', async () => {
  const store = new SettingsStore(); const initial = store.read();
  const validate = next => assertModelChoice([{ model: MODEL, efforts: ['low', 'medium'] }, { model: 'gpt-6-sol', efforts: ['low'] }], next.model, next.effort);
  const first = store.update({ model: 'gpt-6-sol', effort: 'low' }, { validate });
  const second = store.update({ effort: 'medium' }, { validate });
  await first; await assert.rejects(second, /未提供/);
  assert.equal(store.read().model, 'gpt-6-sol'); assert.equal(store.read().effort, 'low');
  assert.notEqual(store.read().promptRevision, initial.promptRevision);
});
