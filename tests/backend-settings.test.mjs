import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsStore, DEFAULT_SETTINGS } from '../bridge/settings.mjs';
import { TranslationService } from '../bridge/translate.mjs';
import { CodexTranslator, INSTRUCTIONS, MODEL } from '../bridge/codex.mjs';
import { createServer } from '../bridge/server.mjs';

const MiB = 1024 * 1024, token = 'a'.repeat(64);
async function temporary(t) {
  const runtime = await mkdtemp(join(tmpdir(), 'luna-settings-'));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  return runtime;
}

test('validated local settings persist atomically with restrictive permissions and no page text', async t => {
  const runtime = await temporary(t), settings = new SettingsStore({ runtime });
  assert.deepEqual((await settings.load()).supplementalPrompt, '');
  const original = settings.read();
  const saved = await settings.update({ supplementalPrompt: 'Keep product names in English.', cacheDays: 7, cacheMaxBytes: 8 * MiB });
  assert.equal(saved.model, MODEL); assert.equal(saved.effort, 'medium'); assert.equal(saved.modelEditable, true);
  assert.equal(saved.basePrompt, INSTRUCTIONS); assert.notEqual(saved.promptRevision, original.promptRevision);
  assert.equal((await stat(join(runtime, 'settings.json'))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(runtime, 'settings.json'), 'utf8')), { version: 2,
    settings: { model: MODEL, effort: 'medium', concurrency: 12, supplementalPrompt: saved.supplementalPrompt, cacheDays: 7, cacheMaxBytes: 8 * MiB } });
  const reopened = new SettingsStore({ runtime });
  assert.deepEqual(await reopened.load(), saved);
  for (const patch of [{ model: 'invalid\nmodel' }, { effort: 'ultra' }, { cacheDays: 365 }, { cacheMaxBytes: MiB },
    { supplementalPrompt: '译'.repeat(4001) }, [], null]) {
    assert.throws(() => settings.update(patch), error => error.status === 400);
  }
  assert.deepEqual(settings.read(), saved);
  await settings.update({ supplementalPrompt: '😀'.repeat(4000) });
  await Promise.all([settings.update({ cacheDays: 90 }), settings.update({ cacheMaxBytes: 16 * MiB })]);
  assert.equal(settings.read().cacheDays, 90); assert.equal(settings.read().cacheMaxBytes, 16 * MiB);
});

test('empty Prompt preserves legacy cache keys; queued requests capture their own Prompt', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const calls = [];
  const service = new TranslationService({ translate: async (texts, target, source, prompt) => {
    calls.push(prompt);
    if (calls.length === 1) { started(); await gate; }
    return texts.map(text => `${prompt || 'default'}:${text}`);
  } }, { effort: 'low' });
  assert.equal(service.key('source', 'zh-CN', 'auto'), createHash('sha256').update(JSON.stringify(['v1', MODEL, 'zh-CN', 'auto', 'source'])).digest('hex'));
  const first = service.translate({ text_list: ['source'] }); await ready;
  service.setSettings({ supplementalPrompt: 'formal' });
  const second = service.translate({ text_list: ['source'] });
  service.setSettings({ supplementalPrompt: 'casual' });
  release();
  assert.equal((await first).translations[0].text, 'default:source');
  assert.equal((await second).translations[0].text, 'formal:source');
  assert.deepEqual(calls, ['', 'formal']);
  assert.equal(service.lookup({ text_list: ['source'] }).cached, 0);
  service.setSettings({ supplementalPrompt: 'formal' });
  assert.equal(service.lookup({ text_list: ['source'] }).translations[0].text, 'formal:source');
  service.setSettings({ supplementalPrompt: '' });
  assert.equal(service.lookup({ text_list: ['source'] }).translations[0].text, 'default:source');
});

test('clear cache invalidates pending writes and persists an empty cache without deleting settings', async t => {
  const runtime = await temporary(t), settings = new SettingsStore({ runtime });
  await settings.update({ cacheDays: 7 });
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const service = new TranslationService({ translate: async texts => { started(); await gate; return texts; } }, { runtime });
  service.store(service.key('old', 'zh-CN', 'auto'), { text: 'old translation', at: Date.now() });
  const running = service.translate({ text_list: ['running'] }); await ready;
  const queued = service.translate({ text_list: ['queued'] });
  await service.clearCache(); release(); await Promise.all([running, queued]);
  assert.equal(service.cache.size, 0);
  assert.deepEqual(JSON.parse(await readFile(join(runtime, 'cache.json'), 'utf8')).items, []);
  assert.equal(JSON.parse(await readFile(join(runtime, 'settings.json'), 'utf8')).settings.cacheDays, 7);
  await service.translate({ text_list: ['new'] });
  assert.equal(service.lookup({ text_list: ['new'] }).cached, 1);
});

test('changing cache limits prunes expired and least recently read fragments', async () => {
  const now = 30 * 86400000, service = new TranslationService({}, { now: () => now });
  service.store(service.key('old', 'zh-CN', 'auto'), { text: 'old', at: now - 8 * 86400000 });
  service.store(service.key('recent', 'zh-CN', 'auto'), { text: 'recent', at: now });
  service.setSettings({ cacheDays: 7 });
  assert.equal(service.lookup({ text_list: ['old', 'recent'] }).cached, 1);
  service.setSettings({ cacheMaxBytes: 128 });
  assert.equal(service.cache.size, 0); assert.equal(service.cacheBytes, 128);
});

test('account status supports missing login and translation rechecks official account/read', async () => {
  const translator = new CodexTranslator();
  translator.ready = Promise.resolve();
  let type = null, accountReads = 0, threads = 0, seenInstructions;
  translator.rpc = async (method, params) => {
    if (method === 'account/read') { accountReads++; return { account: type ? { type } : null }; }
    if (method === 'config/read') return { config: {} };
    if (method === 'model/list') return { data: [{ model: MODEL, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] };
    if (method === 'thread/start') { threads++; seenInstructions = params.developerInstructions; return { model: MODEL, modelProvider: 'openai', thread: { id: 'thread' } }; }
    if (method === 'turn/start') {
      queueMicrotask(() => translator.onMessage({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } }));
      translator.turns.get('thread').text = JSON.stringify({ translations: [{ id: 0, text: '译文' }] });
      return { turn: { id: 'turn' } };
    }
    return {};
  };
  const disconnected = await translator.status();
  assert.equal(disconnected.authentication, 'required'); assert.equal(disconnected.accountConnected, false);
  await assert.rejects(translator.translate(['source'], 'zh-CN'), error => error.status === 401);
  assert.equal(threads, 0);
  type = 'apiKey'; await assert.rejects(translator.translate(['source'], 'zh-CN'), /codex login/);
  type = 'chatgpt'; assert.deepEqual(await translator.translate(['source'], 'zh-CN', 'auto', 'Formal tone.'), ['译文']);
  assert.match(seenInstructions, /Formal tone\./); assert.match(seenInstructions, /Never use tools/);
  type = null; await assert.rejects(translator.translate(['source'], 'zh-CN'), /codex login/);
  assert.equal(threads, 1); assert.equal(accountReads, 5);
});

test('authenticated settings, cache cleanup and account status routes never initiate inference', async t => {
  const runtime = await temporary(t), settings = new SettingsStore({ runtime });
  let calls = 0;
  const translator = { status: async () => ({ model: MODEL, authentication: 'required', accountConnected: false, message: 'Run codex login' }),
    translate: async texts => { calls++; return texts; } };
  const service = new TranslationService(translator, { runtime });
  const server = createServer({ service, settings, translator, token, port: 0 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = (path, { method = 'GET', authorization = token, origin, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: {
      Authorization: `Bearer ${authorization}`, 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}),
    } }, res => { let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) })); });
    req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
  assert.equal((await request('/settings')).body.cacheDays, DEFAULT_SETTINGS.cacheDays);
  assert.equal((await request('/settings', { method: 'POST', body: { cacheDays: 90, supplementalPrompt: 'Formal' } })).status, 200);
  assert.equal(service.ttl / 86400000, 90); assert.equal(service.supplementalPrompt, 'Formal');
  const status = await request('/status');
  assert.equal(status.status, 200); assert.equal(status.body.accountConnected, false);
  assert.equal(status.body.cacheMaxEntries, 10000); assert.equal(status.body.cacheMaxBytes, 32 * MiB);
  assert.equal(status.body.promptRevision, settings.read().promptRevision);
  for (const [path, method, body] of [['/settings', 'GET'], ['/settings', 'POST', { cacheDays: 7 }], ['/cache/clear', 'POST', {}]]) {
    assert.equal((await request(path, { method, body, authorization: 'bad' })).status, 401);
    assert.equal((await request(path, { method, body, origin: 'https://evil.example' })).status, 403);
  }
  service.store(service.key('source', 'zh-CN', 'auto'), { text: 'cached translation', at: Date.now() });
  const cleared = await request('/cache/clear', { method: 'POST', body: {} });
  assert.equal(cleared.status, 200); assert.equal(cleared.body.cleared, true); assert.equal(cleared.body.cacheEntries, 0);
  assert.equal((await request('/settings')).body.supplementalPrompt, 'Formal');
  assert.equal(calls, 0);
});

test('concurrency persists, rejects invalid input and does not invalidate translation caches', async t => {
  const runtime = await temporary(t), store = new SettingsStore({ runtime });
  const before = store.read();
  assert.equal(before.concurrency, 12);
  for (const concurrency of [0, 25, 1.5, '12', null]) assert.throws(() => store.update({ concurrency }), /1–24/);
  const saved = await store.update({ concurrency: 8 });
  assert.equal(saved.promptRevision, before.promptRevision);
  assert.equal((await new SettingsStore({ runtime }).load()).concurrency, 8);
});
