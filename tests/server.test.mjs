import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../bridge/server.mjs';
import { TranslationService } from '../bridge/translate.mjs';

const token = 'a'.repeat(64);
const extensionOrigin = 'chrome-extension://' + 'a'.repeat(32);

async function fixture(t, translate = async texts => texts.map(x => '译文 ' + x)) {
  let calls = 0;
  const translator = { start: async () => ({ model: 'gpt-6-luna', authentication: 'chatgpt' }),
    models: async () => [{ model: 'gpt-6-luna', efforts: ['low', 'medium', 'high'] }, { model: 'gpt-6-sol', efforts: ['medium', 'high'] }],
    translate: async (...args) => { calls++; return translate(...args); } };
  const service = new TranslationService(translator);
  const server = createServer({ service, translator, token, port: 0 });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { service, calls: () => calls, request: (path, options = {}) => new Promise((resolve, reject) => {
    const req = http.request(url + path, { method: options.method || 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } }, res => {
      let raw = ''; res.on('data', c => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: { get: key => res.headers[key.toLowerCase()] || null }, json: async () => JSON.parse(raw) }));
    });
    req.on('error', reject); if (options.body) req.write(options.body); req.end();
  }) };
}

test('token, Host and browser Origin checks block unauthorized inference', async t => {
  const f = await fixture(t), body = JSON.stringify({ text_list: ['example'] });
  for (const headers of [{ Authorization: 'Bearer invalid' }, { Host: 'evil.example:0' }, { Origin: 'https://evil.example' }, { Origin: 'null' }]) {
    const r = await f.request('/translate', { method: 'POST', body, headers });
    assert.ok([401, 403].includes(r.status));
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(f.calls(), 0);
});

test('extension requests and documented Immersive Translate format work', async t => {
  const f = await fixture(t);
  const r = await f.request('/translate', { method: 'POST', headers: { Origin: extensionOrigin }, body: JSON.stringify({ text_list: ['example'], source_lang: 'en', target_lang: 'zh-CN' }) });
  assert.equal(r.status, 200); assert.equal(r.headers.get('access-control-allow-origin'), extensionOrigin);
  assert.deepEqual((await r.json()).translations, [{ text: '译文 example', detected_source_lang: 'en' }]);
  assert.equal((await f.request(`/translate?key=${token}`, { method: 'POST', headers: { Authorization: '' }, body: JSON.stringify({ text_list: ['example'] }) })).status, 200);
});

test('polling jobs expose completion and quota errors without fallback', async t => {
  const f = await fixture(t, async texts => {
    if (texts[0] === 'quota') throw new Error('usage limit reached');
    return texts;
  });
  for (const [text, state] of [['normal', 'completed'], ['quota', 'failed']]) {
    const response = await f.request('/jobs', { method: 'POST', body: JSON.stringify({ text_list: [text] }) });
    assert.equal(response.status, 202);
    const { id } = await response.json();
    const job = await (await f.request(`/jobs/${id}`)).json();
    assert.equal(job.state, state);
    if (state === 'failed') assert.match(job.error, /usage limit/);
  }
});

test('synchronous limit failures return 429 and fallback=false', async t => {
  const f = await fixture(t, async () => { throw new Error('quota exhausted'); });
  const r = await f.request('/translate', { method: 'POST', body: JSON.stringify({ text_list: ['example'] }) });
  assert.equal(r.status, 429); assert.equal((await r.json()).fallback, false);
});

test('authenticated cache lookup returns hits and misses without starting a model request', async t => {
  const f = await fixture(t);
  const body = JSON.stringify({ text_list: ['cached'] });
  assert.equal((await f.request('/translate', { method: 'POST', body })).status, 200);
  const response = await f.request('/cache', { method: 'POST', body: JSON.stringify({ text_list: ['cached', 'missing'] }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.translations[0].text, '译文 cached');
  assert.equal(result.translations[1], null);
  assert.equal(f.calls(), 1);
  for (const headers of [{ Authorization: 'Bearer invalid' }, { Origin: 'https://evil.example' }]) {
    assert([401, 403].includes((await f.request('/cache', { method: 'POST', body, headers })).status));
  }
  assert.equal(f.calls(), 1);
});

test('authenticated model choices persist and unsupported pairs fail without inference', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/models')).status, 200);
  assert.equal((await f.request('/models', { headers: { Authorization: 'Bearer bad' } })).status, 401);
  const save = async body => f.request('/settings', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await save({ model: 'gpt-6-sol', effort: 'high' })).status, 200);
  const state = await (await f.request('/status')).json();
  assert.equal(state.model, 'gpt-6-sol'); assert.equal(state.effort, 'high');
  assert.equal((await save({ effort: 'max' })).status, 400);
  assert.equal((await (await f.request('/settings')).json()).effort, 'high');
  assert.equal((await f.request('/cache', { method: 'POST', body: JSON.stringify({ text_list: ['source'], model: 'gpt-6-luna' }) })).status, 400);
  assert.equal(f.calls(), 0);
});


test('authenticated cancellation removes queued work before inference', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async texts => { await gate; return texts; });
  f.service.setSettings({ concurrency: 1 });
  const submit = async text => (await (await f.request('/jobs', { method: 'POST', body: JSON.stringify({ text_list: [text] }) })).json()).id;
  const first = await submit('running'), queued = await submit('queued');
  const path = `/jobs/${queued}/cancel`;
  assert.equal((await f.request(path, { method: 'POST', headers: { Authorization: 'bad' }, body: '{}' })).status, 401);
  assert.equal((await f.request(path, { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await (await f.request(`/jobs/${queued}`)).json()).state, 'failed');
  release();
  assert.equal(f.calls(), 1);
  assert.equal((await (await f.request(`/jobs/${first}`)).json()).state, 'completed');
});
