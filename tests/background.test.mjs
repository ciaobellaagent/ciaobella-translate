import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
function worker() {
  let listener;
  const jobs = [];
  const config = { endpoint: 'http://127.0.0.1:18472', token: 'a'.repeat(64), target: 'en' };
  const storage = { settings: config, translatedPages: {} };
  const context = vm.createContext({ URL, AbortSignal, Date, TextEncoder, crypto: webcrypto, setTimeout: fn => queueMicrotask(fn),
    chrome: { runtime: {
      getURL: path => `chrome-extension://luna-test/${path}`,
      onMessage: { addListener: fn => { listener = fn; } },
    }, storage: { local: { get: async key => ({ [key]: storage[key] }), set: async value => Object.assign(storage, value) } },
    commands: { onCommand: { addListener() {} } } },
    fetch: async (url, options) => ({ ok: true, json: async () => {
      if (String(url).startsWith('chrome-extension:')) return {};
      if (String(url).endsWith('/settings')) return { model: 'gpt-6-luna', effort: 'medium', concurrency: 12 };
      if (String(url).endsWith('/cache')) return { model: 'gpt-6-luna', translations: [null], cached: 0 };
      if (String(url).endsWith('/jobs')) { jobs.push(JSON.parse(options.body)); return { id: 'job' }; }
      return { state: 'completed', result: { model: 'gpt-6-luna', translations: [{ text: '翻译结果' }] } };
    } }),
  });
  vm.runInContext(source, context);
  const send = (message, sender = { tab: { id: 1 }, url: 'https://example.com/article' }) =>
    new Promise(resolve => listener(message, sender, resolve));
  return { jobs, config, storage, send };
}

test('page control reads scheduler and language preferences without inference or disclosing credentials', async () => {
  const w = worker();
  const reply = await w.send({ type: 'LUNA_PAGE_CONFIG' });
  assert.equal(reply.ok, true);
  assert.equal(reply.result.target, 'en');
  assert.deepEqual(Object.keys(reply.result), ['target', 'model', 'effort', 'concurrency']);
  assert.equal(reply.result.concurrency, 12);
  assert.equal(w.jobs.length, 0);
});

test('page translation keeps its selected language when global preferences have changed', async () => {
  const w = worker();
  const reply = await w.send({ type: 'LUNA_TRANSLATE', target: 'ja', texts: ['Keep the current page language.'] });
  assert.equal(reply.ok, true);
  assert.equal(w.jobs[0].target_lang, 'ja');
  assert.equal(w.jobs[0].model, undefined, 'The bridge selects the saved model; page requests cannot override it');
  const invalid = await w.send({ type: 'LUNA_TRANSLATE', target: 'invalid', texts: ['No inference should start.'] });
  assert.equal(invalid.ok, false);
  assert.equal(w.jobs.length, 1);
});

test('only remembered pages qualify for cache-only restore, with no inference or raw URL stored', async () => {
  const w = worker(), sender = { tab: { id: 1 }, url: 'https://example.com/read?q=a%20b~&id=1&utm_source=first#inbox' };
  assert.equal((await w.send({ type: 'LUNA_RESTORE_CONFIG' }, sender)).result.restore, false);
  assert.equal((await w.send({ type: 'LUNA_REMEMBER', target: 'en' }, sender)).ok, true);
  const same = { ...sender, url: 'https://example.com/read?q=a%20b~&id=1#inbox' };
  assert.equal((await w.send({ type: 'LUNA_RESTORE_CONFIG' }, same)).result.restore, true);
  assert.equal((await w.send({ type: 'LUNA_RESTORE_CONFIG' }, { ...same, url: same.url.replace('#inbox', '#settings') })).result.restore, false);
  assert.equal((await w.send({ type: 'LUNA_RESTORE_CONFIG' }, { ...same, url: same.url.replace('id=1', 'id=2') })).result.restore, false);
  assert(Object.keys(w.storage.translatedPages).every(key => /^[a-f0-9]{64}$/.test(key)));
  assert(!JSON.stringify(w.storage.translatedPages).includes('example.com'));
  w.config.target = 'ja';
  assert.equal((await w.send({ type: 'LUNA_RESTORE_CONFIG' }, same)).result.restore, false);
  assert.equal(w.jobs.length, 0);
});

test('concurrent page registrations survive and old registrations expire without inference', async () => {
  const w = worker();
  const senders = Array.from({ length: 12 }, (_, id) => ({ tab: { id: id + 1 }, url: `https://example.com/read?id=${id}` }));
  await Promise.all(senders.map(sender => w.send({ type: 'LUNA_REMEMBER', target: 'en' }, sender)));
  assert.equal(Object.keys(w.storage.translatedPages).length, 12);
  for (const page of Object.values(w.storage.translatedPages)) page.at = Date.now() - 31 * 86400000;
  assert.equal((await w.send({ type: 'LUNA_RESTORE_CONFIG' }, senders[0])).result.restore, false);
  await w.send({ type: 'LUNA_CACHE', target: 'en', texts: ['No cached result'] }, senders[0]);
  assert.equal(w.jobs.length, 0);
});

test('appearance preferences stay local; page controls cannot read credentials or edit service settings', async () => {
  const w = worker(), own = { url: 'chrome-extension://luna-test/options.html' };
  assert.equal((await w.send({ type: 'LUNA_SETTINGS' })).ok, false);
  const ui = await w.send({ type: 'LUNA_UI_CONFIG' });
  assert.equal(ui.result.side, 'right'); assert.equal(ui.result.token, undefined);
  assert.equal((await w.send({ type: 'LUNA_SERVICE_SAVE', settings: { supplementalPrompt: 'anything' } })).ok, false);
  assert.equal((await w.send({ type: 'LUNA_MODELS' })).ok, false);
  assert.equal((await w.send({ type: 'LUNA_SAVE', settings: { side: 'left', autoHide: false, showLauncher: false, autoRestore: false } }, own)).ok, true);
  assert.equal((await w.send({ type: 'LUNA_UI_CONFIG' })).result.showLauncher, false);
  assert.equal((await w.send({ type: 'LUNA_FLOAT_SAVE', side: 'right', vertical: .7 })).ok, true);
  assert.equal((await w.send({ type: 'LUNA_FLOAT_SAVE', side: 'right', vertical: 5 })).ok, false);
  assert.equal(w.storage.settings.target, 'en'); assert.equal(w.storage.settings.vertical, .7);
  await w.send({ type: 'LUNA_REMEMBER', target: 'en' });
  assert.equal((await w.send({ type: 'LUNA_RESTORE_CONFIG' })).result.restore, false);
  assert.equal(w.jobs.length, 0);
});

test('concurrent preference patches and drag position preserve each other', async () => {
  const w = worker(), own = { url: 'chrome-extension://luna-test/options.html' };
  const replies = await Promise.all([
    w.send({ type: 'LUNA_SAVE', settings: { target: 'ja' } }, own),
    w.send({ type: 'LUNA_SAVE', settings: { showLauncher: false } }, own),
    w.send({ type: 'LUNA_FLOAT_SAVE', side: 'left', vertical: .25 }),
  ]);
  assert(replies.every(reply => reply.ok));
  assert.equal(w.storage.settings.target, 'ja'); assert.equal(w.storage.settings.showLauncher, false);
  assert.equal(w.storage.settings.side, 'left'); assert.equal(w.storage.settings.vertical, .25);
});

test('unpaired installations can save local preferences while service access stays blocked', async () => {
  const w = worker(), own = { url: 'chrome-extension://luna-test/options.html' };
  w.config.token = '';
  assert.equal((await w.send({ type: 'LUNA_SAVE', settings: { target: 'ja', showLauncher: false } }, own)).ok, true);
  assert.equal(w.storage.settings.target, 'ja'); assert.equal(w.storage.settings.token, '');
  assert.equal((await w.send({ type: 'LUNA_STATUS' }, own)).ok, false);
  assert.equal((await w.send({ type: 'LUNA_SAVE', settings: { token: 'bad' } }, own)).ok, false);
  assert.equal(w.jobs.length, 0);
});

test('site rules persist across URLs, isolate hostnames and allow scoped removal', async () => {
  const w = worker();
  const saved = await w.send({ type: 'LUNA_RULE_SAVE', selector: 'article > div.author' });
  assert.equal(saved.ok, true);
  const same = await w.send({ type: 'LUNA_RULES' }, { tab: { id: 2 }, url: 'https://example.com/other' });
  assert.equal(same.result.rules.length, 1);
  const other = { tab: { id: 3 }, url: 'https://other.example.com/' };
  assert.equal((await w.send({ type: 'LUNA_RULES' }, other)).result.rules.length, 0);
  await w.send({ type: 'LUNA_RULE_DELETE', host: 'example.com', id: saved.result.id }, other);
  assert.equal((await w.send({ type: 'LUNA_RULES' })).result.rules.length, 1);
  await w.send({ type: 'LUNA_RULE_DELETE', id: saved.result.id });
  assert.equal((await w.send({ type: 'LUNA_RULES' })).result.rules.length, 0);
  assert.equal((await w.send({ type: 'LUNA_RULE_LIST' })).ok, false);
  assert.equal(w.jobs.length, 0);
});
