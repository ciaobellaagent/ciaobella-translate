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

test('concurrent identical batches share the cache and inference remains serial', async () => {
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
