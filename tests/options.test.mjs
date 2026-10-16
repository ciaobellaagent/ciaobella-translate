import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';

const [source, html] = await Promise.all([
  readFile(new URL('../extension/options.js', import.meta.url), 'utf8'),
  readFile(new URL('../extension/options.html', import.meta.url), 'utf8'),
]);
const MiB = 1024 * 1024;

// Run the real options script and its registered event listeners. The DOM only
// supplies the elements declared by the real page; no browser or network exists.
class Element {
  constructor(id, classes) {
    this.id = id;
    this.className = classes;
    this.disabled = false;
    this.checked = false;
    this.textContent = '';
    this.listeners = new Map();
    this.value = '';
  }

  get value() { return this.currentValue; }
  set value(value) { this.currentValue = String(value); }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  replaceChildren(...children) { this.children = children; }

  async fire(type) {
    const event = { type, target: this, currentTarget: this, preventDefault() {} };
    await Promise.all((this.listeners.get(type) || []).map(listener => listener(event)));
  }
}

async function optionsPage({ catalogError } = {}) {
  const elements = new Map();
  for (const [, , attrs] of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const id = attrs.match(/\bid="([^"]+)"/)?.[1];
    if (id) elements.set(id, new Element(id, attrs.match(/\bclass="([^"]*)"/)?.[1] || ''));
  }
  const element = id => {
    assert(elements.has(id), `The settings page must contain #${id}`);
    return elements.get(id);
  };
  const service = { model: 'gpt-6-luna', effort: 'medium', supplementalPrompt: 'Existing translation instructions.', cacheDays: 30,
    cacheMaxBytes: 32 * MiB, basePrompt: 'Program-managed translation rules.', promptRevision: 'initial' };
  const local = { endpoint: 'http://127.0.0.1:18472', token: 'a'.repeat(64), target: 'zh-CN', side: 'right',
    autoRestore: true, showLauncher: true, autoHide: true };
  const calls = [];
  let saveError, nextSaveGate, nextCatalogGate;
  const models = [
    { model: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
    { model: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: ['medium', 'high'], defaultEffort: 'medium' },
  ];
  const status = () => ({ authentication: 'chatgpt', model: service.model, effort: service.effort, cacheBytes: 2048,
    cacheEntries: 4, cacheMaxEntries: 10000, cacheDays: service.cacheDays, cacheMaxBytes: service.cacheMaxBytes });
  const context = vm.createContext({
    document: {
      getElementById: element,
      createElement() { return new Element('', ''); },
      querySelectorAll(selector) {
        assert.equal(selector, '.service-control');
        return [...elements.values()].filter(node => node.className.split(/\s+/).includes('service-control'));
      },
    },
    chrome: { runtime: { async sendMessage(message) {
      const request = structuredClone(message);
      calls.push(request);
      switch (request.type) {
        case 'LUNA_SETTINGS': return { ok: true, result: { ...local } };
        case 'LUNA_STATUS': return { ok: true, result: status() };
        case 'LUNA_SERVICE_SETTINGS': return { ok: true, result: { ...service } };
        case 'LUNA_MODELS': {
          const gate = nextCatalogGate; nextCatalogGate = null;
          if (gate) { gate.started(); await gate.pending; }
          return catalogError ? { ok: false, error: catalogError } : { ok: true, result: { models } };
        }
        case 'LUNA_SAVE':
          Object.assign(local, request.settings);
          return { ok: true, result: { saved: true } };
        case 'LUNA_SERVICE_SAVE': {
          const gate = nextSaveGate; nextSaveGate = null;
          if (gate) { gate.started(); await gate.pending; }
          if (saveError) {
            const error = saveError; saveError = null;
            return { ok: false, error };
          }
          Object.assign(service, request.settings);
          return { ok: true, result: { ...service } };
        }
        default: throw new Error(`Unexpected settings request: ${request.type}`);
      }
    } } },
  });
  vm.runInContext(source, context, { filename: 'extension/options.js' });
  await setImmediate();
  assert.equal(element('base-prompt').textContent, service.basePrompt, 'Initial asynchronous loading must finish');
  assert.equal(element('save-prompt').disabled, false);
  return {
    element, calls, service, models,
    async edit(id, value, type = 'input') {
      element(id).value = value;
      await element(id).fire(type);
    },
    async click(id) {
      assert.equal(element(id).disabled, false, `#${id} must be actionable`);
      await element(id).fire('click');
    },
    failNextSave(message = '模拟保存失败：设置文件不可写。') { saveError = message; },
    holdNextSave() {
      let release, started;
      const pending = new Promise(resolve => { release = resolve; });
      const requested = new Promise(resolve => { started = resolve; });
      nextSaveGate = { pending, started };
      return { requested, release };
    },
    holdNextCatalog() {
      let release, started;
      const pending = new Promise(resolve => { release = resolve; });
      const requested = new Promise(resolve => { started = resolve; });
      nextCatalogGate = { pending, started };
      return { requested, release };
    },
  };
}

async function editCache(page, days = 7, maxBytes = 16 * MiB) {
  await page.edit('cacheDays', days, 'change');
  await page.edit('cacheMaxBytes', maxBytes, 'change');
}

function assertDraft(page, prompt, days = 7, maxBytes = 16 * MiB) {
  assert.equal(page.element('supplementalPrompt').value, prompt);
  assert.equal(page.element('cacheDays').value, String(days));
  assert.equal(page.element('cacheMaxBytes').value, String(maxBytes));
}

test('checking the connection preserves edited prompt and cache drafts, including an unsaved default reset', async () => {
  const page = await optionsPage(), draft = 'Technical terms stay consistent.';
  await page.edit('supplementalPrompt', draft);
  await editCache(page);
  // A later connection check sees newer published settings, not the local drafts.
  Object.assign(page.service, { supplementalPrompt: 'Changed in another settings view.', cacheDays: 90, cacheMaxBytes: 8 * MiB });
  await page.click('test');
  assertDraft(page, draft);
  assert.match(page.element('connection').textContent, /已连接/);
  assert.match(page.element('cache-limit').textContent, /90 天/);
  assert.equal(page.calls.filter(call => call.type === 'LUNA_SERVICE_SAVE').length, 0);
  await page.click('default-prompt');
  await page.click('test');
  assertDraft(page, '');
});

test('saving a prompt retains an independent unsaved cache draft', async () => {
  const page = await optionsPage(), draft = 'Keep product names in English.';
  await page.edit('supplementalPrompt', draft);
  await editCache(page);
  await page.click('save-prompt');
  assert.equal(page.service.supplementalPrompt, draft);
  assert.equal(page.service.cacheDays, 30);
  assert.equal(page.service.cacheMaxBytes, 32 * MiB);
  assertDraft(page, draft);
  const saved = page.calls.filter(call => call.type === 'LUNA_SERVICE_SAVE');
  assert.deepEqual(saved.map(call => call.settings), [{ supplementalPrompt: draft }]);
  await page.click('test');
  assertDraft(page, draft);
});

test('a failed prompt save keeps the draft and allows a retry without losing cache edits', async () => {
  const page = await optionsPage(), draft = 'A prompt that has not been saved yet.';
  await page.edit('supplementalPrompt', draft);
  await editCache(page);
  page.failNextSave();
  await page.click('save-prompt');
  assertDraft(page, draft);
  assert.equal(page.service.supplementalPrompt, 'Existing translation instructions.');
  assert.match(page.element('notice').textContent, /模拟保存失败/);
  assert.equal(page.element('save-prompt').disabled, false);
  await page.click('test');
  assertDraft(page, draft);
  await page.click('save-prompt');
  assert.equal(page.service.supplementalPrompt, draft);
  assertDraft(page, draft);
});

test('a failed cache save retains both cache fields and the independent prompt draft', async () => {
  const page = await optionsPage(), draft = 'An independent prompt draft.';
  await page.edit('supplementalPrompt', draft);
  await editCache(page, 90, 8 * MiB);
  page.failNextSave();
  await page.click('save-cache');
  assertDraft(page, draft, 90, 8 * MiB);
  assert.equal(page.service.cacheDays, 30);
  assert.equal(page.service.cacheMaxBytes, 32 * MiB);
  assert.match(page.element('notice').textContent, /模拟保存失败/);
  assert.equal(page.element('save-cache').disabled, false);
  await page.click('test');
  assertDraft(page, draft, 90, 8 * MiB);
});

test('editing a prompt while its save is pending does not replace the newer draft on completion', async () => {
  const page = await optionsPage();
  await page.edit('supplementalPrompt', 'The submitted prompt.');
  const gate = page.holdNextSave();
  const saving = page.click('save-prompt');
  await gate.requested;
  assert.equal(page.element('save-prompt').disabled, true);
  await page.edit('supplementalPrompt', 'A newer unsaved prompt.');
  gate.release();
  await saving;
  assert.equal(page.service.supplementalPrompt, 'The submitted prompt.');
  assert.equal(page.element('supplementalPrompt').value, 'A newer unsaved prompt.');
  await page.click('test');
  assert.equal(page.element('supplementalPrompt').value, 'A newer unsaved prompt.');
});

test('model/effort selectors default to medium and preserve drafts on a connection recheck', async () => {
  const page = await optionsPage();
  assert.equal(page.element('model').value, 'gpt-6-luna');
  assert.equal(page.element('effort').value, 'medium');
  await page.edit('effort', 'low', 'change');
  await page.edit('model', 'gpt-6-sol', 'change');
  assert.equal(page.element('effort').value, 'medium', 'Unsupported low is replaced visibly before saving');
  await page.edit('effort', 'high', 'change');
  await page.click('test');
  assert.equal(page.element('model').value, 'gpt-6-sol'); assert.equal(page.element('effort').value, 'high');
  await page.edit('supplementalPrompt', 'Unsaved prompt'); await editCache(page);
  await page.click('save-model');
  assert.equal(page.service.model, 'gpt-6-sol'); assert.equal(page.service.effort, 'high');
  assertDraft(page, 'Unsaved prompt');
});

test('model catalog failure leaves other preferences available and disables model saves', async () => {
  const page = await optionsPage({ catalogError: '模型列表暂时不可用' });
  assert.equal(page.element('save-model').disabled, true); assert.equal(page.element('model').disabled, true);
  assert.equal(page.element('save-prompt').disabled, false);
  assert.match(page.element('model-help').textContent, /模型列表暂时不可用/);
});

test('failed model saves preserve the selected model and effort for retry', async () => {
  const page = await optionsPage(); await page.edit('effort', 'high', 'change');
  page.failNextSave(); await page.click('save-model');
  assert.equal(page.service.effort, 'medium'); assert.equal(page.element('effort').value, 'high');
  await page.click('test'); assert.equal(page.element('effort').value, 'high');
  await page.click('save-model'); assert.equal(page.service.effort, 'high');
});

test('a slow catalog recheck cannot overwrite a model saved while it was pending', async () => {
  const page = await optionsPage();
  await page.edit('effort', 'high', 'change');
  const gate = page.holdNextCatalog(), checking = page.click('test');
  await gate.requested;
  await page.click('save-model'); assert.equal(page.service.effort, 'high');
  gate.release(); await checking;
  assert.equal(page.element('effort').value, 'high');
  assert.match(page.element('account-detail').textContent, /high/);
});

test('an unavailable saved effort stays visible and cannot silently become a different saved choice', async () => {
  const page = await optionsPage();
  await page.edit('effort', 'high', 'change'); await page.click('save-model');
  page.models[0].efforts = ['low', 'medium']; await page.click('test');
  assert.equal(page.service.effort, 'high'); assert.equal(page.element('effort').value, 'high');
  assert.equal(page.element('save-model').disabled, true);
  assert.match(page.element('model-help').textContent, /当前不可用/);
  await page.edit('effort', 'medium', 'change'); assert.equal(page.element('save-model').disabled, false);
});
