import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranslationService } from '../bridge/translate.mjs';

const day = 86400000;
async function runtime(t) {
  const folder = await mkdtemp(join(tmpdir(), 'luna-cache-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

test('30-day expiry uses generation time; cache reads never extend it or start inference', async () => {
  let now = 1000, calls = 0;
  const service = new TranslationService({ translate: async texts => { calls++; return texts; } }, { now: () => now });
  await service.translate({ text_list: ['same'] });
  now += 29 * day;
  assert.equal(service.lookup({ text_list: ['same'] }).cached, 1);
  now += day;
  assert.deepEqual(service.lookup({ text_list: ['same'] }).translations, [null]);
  assert.equal(calls, 1);
  await service.translate({ text_list: ['same'] });
  assert.equal(calls, 2);
});

test('unchanged paragraphs survive URL-independent reads; only changed text or language misses', async () => {
  const calls = [];
  const service = new TranslationService({ translate: async (texts, target) => { calls.push({ texts, target }); return texts.map(text => target + text); } });
  await service.translate({ text_list: ['unchanged', 'old paragraph'] });
  const cached = service.lookup({ text_list: ['unchanged', 'new paragraph'] });
  assert.equal(cached.translations[0].text, 'zh-CNunchanged');
  assert.equal(cached.translations[1], null);
  await service.translate({ text_list: ['unchanged', 'new paragraph'] });
  assert.deepEqual(calls[1].texts, ['new paragraph']);
  assert.equal(service.lookup({ text_list: ['unchanged'], target_lang: 'ja' }).cached, 0);
  assert.equal(service.lookup({ text_list: ['unchanged'], source_lang: 'en' }).cached, 0);
});

test('cache-only and fully cached requests bypass a saturated model queue', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const service = new TranslationService({ translate: async texts => { if (texts[0].startsWith('slow')) await gate; return texts; } });
  await service.translate({ text_list: ['cached'] });
  const waiting = Array.from({ length: 16 }, (_, i) => service.translate({ text_list: ['slow' + i] }));
  assert.equal(service.pending, 16);
  assert.equal(service.lookup({ text_list: ['cached', 'missing'] }).cached, 1);
  let timer;
  try {
    const cached = await Promise.race([service.translate({ text_list: ['cached'] }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Cache waited behind inference')), 150); })]);
    assert.equal(cached.cached, 1);
  } finally { clearTimeout(timer); release(); await Promise.all(waiting); }
});

test('disk cache survives restart and imports legacy v1 entries at their original age', async t => {
  const folder = await runtime(t), now = Date.now();
  const first = new TranslationService({ translate: async () => ['saved translation'] }, { runtime: folder, effort: 'low' });
  await first.translate({ text_list: ['original'] });
  const file = join(folder, 'cache.json'), legacy = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(legacy.version, 2);
  // A genuine legacy file uses the old envelope and Luna+low key namespace.
  legacy.version = 1; legacy.model = 'gpt-6-luna';
  legacy.items[0][1].at = now - 8 * day;
  await writeFile(file, JSON.stringify(legacy));
  const reopened = new TranslationService({ translate: async () => { throw Error('No new inference expected'); } }, { runtime: folder, effort: 'low', now: () => now });
  await reopened.load();
  assert.equal((await reopened.translate({ text_list: ['original'] })).translations[0].text, 'saved translation');
  assert.equal(reopened.cache.values().next().value.at, now - 8 * day);
});

test('LRU protects recently read paragraphs and UTF-8 byte limits bound persistent storage', async t => {
  const service = new TranslationService({ translate: async texts => texts }, { maxCache: 2 });
  await service.translate({ text_list: ['A', 'B'] });
  service.lookup({ text_list: ['A'] });
  await service.translate({ text_list: ['C'] });
  assert.equal(service.lookup({ text_list: ['A'] }).cached, 1);
  assert.equal(service.lookup({ text_list: ['B'] }).cached, 0);
  const folder = await runtime(t);
  const bounded = new TranslationService({ translate: async texts => texts.map(text => '译'.repeat(150) + text) }, { runtime: folder, maxBytes: 1000 });
  const result = await bounded.translate({ text_list: ['one', 'two', 'three'] });
  assert.equal(result.translations.length, 3);
  assert(bounded.cacheBytes <= 1000);
  assert((await readFile(join(folder, 'cache.json'))).length <= 1000);
});

test('cache-only LRU touches persist across restart without a new translation', async t => {
  const folder = await runtime(t);
  const first = new TranslationService({ translate: async texts => texts }, { runtime: folder, maxCache: 2 });
  await first.translate({ text_list: ['A', 'B'] });
  first.lookup({ text_list: ['A'] });
  await first.flush();
  const reopened = new TranslationService({ translate: async texts => texts }, { runtime: folder, maxCache: 2 });
  await reopened.load();
  await reopened.translate({ text_list: ['C'] });
  assert.equal(reopened.lookup({ text_list: ['A'] }).cached, 1);
  assert.equal(reopened.lookup({ text_list: ['B'] }).cached, 0);
  await reopened.flush();
});
