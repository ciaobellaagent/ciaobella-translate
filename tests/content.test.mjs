import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const fixture = await readFile(new URL('../fixtures/x-timeline.html', import.meta.url), 'utf8');
const MARK = '[data-luna-translation]';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate) {
  const end = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > end) assert.fail('Content script did not reach the expected DOM state');
    await sleep(10);
  }
}

// Execute the unchanged content script against a real DOM implementation.
// Visibility/intersections are simulated; this proves extraction and insertion,
// not Chromium pixel layout or the current structure of the live X website.
async function page(t, { html = fixture, url = 'https://x.com/home', cached = false, gate, rules = [], config = {}, translate, boundsFor } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const { window } = dom;
  const observers = [], NativeMutationObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeMutationObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  t.after(() => { observers.forEach(observer => observer.disconnect()); window.close(); });
  const calls = [], listeners = [], storageListeners = [];
  const bounds = { x: 0, y: 100, top: 100, bottom: 130, left: 0, right: 600, width: 600, height: 30 };
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest('[hidden]') || window.getComputedStyle(this).display === 'none' ? [] : [bounds];
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () { return boundsFor?.(this) || bounds; };
  window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); }
    observe(target) {
      this.targets.add(target);
      window.queueMicrotask(() => {
        if (this.targets.has(target)) this.callback([{ target, isIntersecting: true }]);
      });
    }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  };
  window.chrome = {
    runtime: {
      getURL: path => `chrome-extension://${'a'.repeat(32)}/${path}`,
      onMessage: { addListener: listener => listeners.push(listener) },
      async sendMessage(message) {
        const request = JSON.parse(JSON.stringify(message)); calls.push(request);
        switch (request.type) {
          case 'LUNA_RULES': return { ok: true, result: { rules } };
          case 'LUNA_CANCEL': return { ok: true, result: {} };
          case 'LUNA_RULE_SAVE': { const rule = { id: 'saved-rule', selector: request.selector }; rules.push(rule); return { ok: true, result: rule }; }
          case 'LUNA_RULE_DELETE': rules = rules.filter(rule => rule.id !== request.id); return { ok: true, result: {} };
          case 'LUNA_UI_CONFIG': return { ok: true, result: {} };
          case 'LUNA_RESTORE_CONFIG': return { ok: true, result: { target: 'zh-CN', restore: false } };
          case 'LUNA_REMEMBER': return { ok: true, result: { remembered: true } };
          case 'LUNA_CACHE': return { ok: true, result: { model: config.model || 'gpt-6-luna',
            translations: request.texts.map(text => cached ? { text: '缓存译文：' + text } : null) } };
          case 'LUNA_TRANSLATE':
            if (gate) await gate;
            if (translate) await translate(request);
            return { ok: true, result: { model: config.model || 'gpt-6-luna', translations: request.texts.map(text => ({ text: '译文：' + text })) } };
          default: throw Error(`Unexpected content request: ${request.type}`);
        }
      },
    },
    storage: { onChanged: { addListener(fn) { storageListeners.push(fn); } } },
  };
  window.eval(source);
  const action = value => {
    let result;
    listeners[0]({ type: 'LUNA_PAGE', action: value, target: 'zh-CN', ...config }, {}, value => { result = value; });
    return result;
  };
  return { window, document: window.document, calls, action, change: changes => storageListeners.forEach(fn => fn(changes, 'local')),
    texts: type => calls.filter(call => call.type === type).flatMap(call => call.texts) };
}

test('X sends whole posts, excludes author/UI metadata, and leaves inline mention links intact', async t => {
  const p = await page(t);
  const author = p.document.querySelector('#author'), mention = p.document.querySelector('#mention');
  const originalAuthor = author.outerHTML, originalMention = mention.outerHTML;
  const link = mention.querySelector('a');
  p.action('start');
  await until(() => p.action('status').translated === 4 && !p.action('status').busy);
  const inputs = p.texts('LUNA_TRANSLATE');
  assert(inputs.includes('We discussed the next release with __LUNA_KEEP_0__ and kept every original link in place.'));
  assert(!inputs.some(text => /fixture_author|Example Researcher|minutes ago|Show more|Repost|People you|Trending/.test(text)));
  assert(!inputs.includes('@fixture_team'));
  assert(p.document.querySelector('#post-body ' + MARK).textContent.includes('@fixture_team'));
  assert(!p.document.querySelector('#post-body ' + MARK).textContent.includes('__LUNA_KEEP_'));
  assert.equal(author.outerHTML, originalAuthor);
  assert.equal(mention.outerHTML, originalMention);
  assert.equal(mention.querySelector('a'), link);
  assert.equal(link.getAttribute('href'), '/fixture_team');
  assert.equal(p.document.querySelectorAll('#post-body ' + MARK).length, 1);
  assert.equal(p.document.querySelectorAll('#mention ' + MARK).length, 0);
  assert.equal(p.document.querySelectorAll('#chinese-body ' + MARK).length, 0);
  assert.equal(p.document.querySelectorAll('#actions [data-luna-ui],#author [data-luna-ui]').length, 0);
  assert.equal(p.document.querySelectorAll('#handle-only ' + MARK).length, 0);
  assert(p.document.querySelector('#bio > ' + MARK));
  assert(p.document.querySelector('#article-first > ' + MARK));
  assert(p.document.querySelector('#article-second > ' + MARK));
});

test('cached X content uses the same whole-post boundary without restoring handle-only fragments', async t => {
  const p = await page(t, { url: 'https://mobile.twitter.com/home', cached: true });
  p.action('start');
  await until(() => p.document.querySelector('#post-body > ' + MARK) && !p.action('status').busy);
  assert.equal(p.texts('LUNA_TRANSLATE').length, 0);
  assert(p.texts('LUNA_CACHE').some(text => text.includes('with __LUNA_KEEP_0__ and')));
  assert.equal(p.document.querySelectorAll('#author ' + MARK + ',#mention ' + MARK + ',#chinese-body ' + MARK).length, 0);
});

test('X nested text mutations rescan the whole post, and reset restores authored DOM', async t => {
  const p = await page(t);
  p.action('start');
  await until(() => p.document.querySelector('#post-body > ' + MARK) && !p.action('status').busy);
  const body = p.document.querySelector('#post-body');
  // Framework replacement removes our old translation and changes an inline div.
  body.innerHTML = '<span>A revised message for </span><div class="mention"><a href="/second_team">@second_team</a></div><span> remains one complete paragraph.</span>';
  const original = body.innerHTML;
  await until(() => body.querySelector(MARK)?.textContent.includes('A revised message'));
  assert(p.texts('LUNA_TRANSLATE').includes('A revised message for __LUNA_KEEP_0__ remains one complete paragraph.'));
  assert.equal(body.querySelectorAll(MARK).length, 1);
  assert.equal(body.querySelectorAll('.mention ' + MARK).length, 0);
  p.action('reset');
  assert.equal(body.innerHTML, original);
  assert.equal(p.document.querySelectorAll(MARK).length, 0);
  assert.equal(p.document.querySelectorAll('[data-luna-ui="progress"]').length, 0);
});

test('a previously untranslated X post rescans its atomic root after an inline mutation', async t => {
  const original = '这是一条中文测试消息，原文已经是目标语言，首次扫描时不应翻译，也不应给其中的账号生成独立的译文。';
  const p = await page(t, { html: `<div data-testid="tweetText" id="body"><span>${original}</span><div id="inline">@fixture_team</div></div>` });
  p.action('start');
  await sleep(20);
  assert.equal(p.action('status').total, 0);
  assert.equal(p.texts('LUNA_TRANSLATE').length, 0);
  const body = p.document.querySelector('#body');
  const expanded = 'A newly expanded English update from @fixture_team should now be translated as one post, together with its original surrounding text. The inline wrapper is not a separate paragraph and must never receive its own translation.';
  p.document.querySelector('#inline').textContent = expanded;
  await until(() => body.querySelector(MARK));
  assert(p.texts('LUNA_TRANSLATE').includes(original + expanded.replace('@fixture_team', '__LUNA_KEEP_0__')));
  assert.equal(p.document.querySelectorAll('#inline ' + MARK).length, 0);
});

test('late replies cannot insert translations after an X body becomes author metadata', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const p = await page(t, { html: '<div data-testid="tweetText" id="body">A synthetic post waiting for translation.</div>', gate });
  p.action('start');
  await until(() => p.texts('LUNA_TRANSLATE').length > 0);
  p.document.querySelector('#body').dataset.testid = 'User-Name';
  release();
  await until(() => !p.action('status').busy);
  assert.equal(p.document.querySelectorAll(MARK).length, 0);
});

test('other websites keep normal block extraction instead of inheriting X site rules', async t => {
  const html = '<main><h1>A normal article heading</h1><p id="paragraph">Read <a href="/next">the original link</a> in context.</p><div id="mixed">Direct container text remains readable.<p id="nested">A nested paragraph is separate.</p></div><div id="handle">@fixture_team</div></main>';
  const p = await page(t, { url: 'https://example.com/article', html });
  p.action('start');
  await until(() => p.document.querySelector('#nested > ' + MARK) && !p.action('status').busy);
  const inputs = p.texts('LUNA_TRANSLATE');
  assert(inputs.includes('Read the original link in context.'));
  assert(inputs.includes('Direct container text remains readable.'));
  assert(inputs.includes('A nested paragraph is separate.'));
  assert(!inputs.includes('@fixture_team'));
  assert.equal(p.document.querySelectorAll('#paragraph ' + MARK).length, 1);
  assert.equal(p.document.querySelector('#paragraph a').getAttribute('href'), '/next');
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const paragraphs = count => Array.from({ length: count }, (_, i) => `<p id="p${i}">Paragraph ${i} contains enough English text for translation.</p>`).join('');
function picker(p) { return p.document.querySelector('[data-luna-ui="picker"]')?.shadowRoot; }
function pickerClick(p, label) {
  const button = [...picker(p).querySelectorAll('button')].find(button => button.textContent.startsWith(label));
  assert(button && !button.disabled, `Picker action ${label} is available`); button.click();
}

test('page dispatches several small batches, honors limit and renders each independent completion', async t => {
  const holds = [];
  const p = await page(t, { url: 'https://example.com', html: paragraphs(16), config: { concurrency: 3 },
    translate: request => { const hold = deferred(); holds.push({ ...hold, request }); return hold.promise; } });
  p.action('start'); await until(() => holds.length === 3);
  assert(holds.every(hold => hold.request.texts.length === 4));
  assert.equal(new Set(holds.flatMap(hold => hold.request.texts)).size, 12);
  holds[1].resolve(); await until(() => p.document.querySelectorAll(MARK).length === 4 && holds.length === 4);
  assert.equal(p.document.querySelector('#p0 ' + MARK), null);
  holds.forEach(hold => hold.resolve()); await until(() => p.action('status').translated === 16);
});

test('visible blocks outrank DOM-earlier prefetch blocks; live concurrency updates fill available slots', async t => {
  const hold = deferred();
  const p = await page(t, { url: 'https://example.com', html: paragraphs(12), gate: hold.promise, config: { concurrency: 1 },
    boundsFor: element => ({ top: element.id === 'p0' ? 900 : 100, bottom: element.id === 'p0' ? 930 : 130, left: 0, right: 600, width: 600, height: 30 }) });
  p.action('start'); await until(() => p.texts('LUNA_TRANSLATE').length === 4);
  assert(!p.texts('LUNA_TRANSLATE').some(text => text.startsWith('Paragraph 0 ')));
  p.change({ schedulerConfig: { newValue: { concurrency: 3 } } });
  await until(() => p.calls.filter(call => call.type === 'LUNA_TRANSLATE').length === 3);
  hold.resolve(); await until(() => p.action('status').translated === 12);
});

test('pause/restart isolates old responses and supports a non-Luna selected model', async t => {
  const holds = [];
  const p = await page(t, { url: 'https://example.com', html: paragraphs(4), config: { concurrency: 2, model: 'gpt-6-sol' },
    translate: () => { const hold = deferred(); holds.push(hold); return hold.promise; } });
  p.action('start'); await until(() => holds.length === 1);
  p.action('pause'); p.action('start'); await until(() => holds.length === 2);
  holds[0].resolve(); await sleep(20);
  assert.equal(p.document.querySelectorAll(MARK).length, 0);
  assert.equal(p.action('status').activeBatches, 1);
  holds[1].resolve(); await until(() => p.action('status').translated === 4);
  assert.equal(p.action('status').error, '');
});

test('picker previews same-type exclusions, removes existing translations and covers newly added cards', async t => {
  const html = '<article><div class="author">Example Researcher One</div><p>A readable first post.</p></article><article><div class="author">Example Researcher Two</div><p>A readable second post.</p></article>';
  const p = await page(t, { url: 'https://example.com', html });
  p.action('start'); await until(() => p.action('status').translated === 4);
  p.action('pick');
  p.document.querySelector('.author').dispatchEvent(new p.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.match(picker(p).textContent, /2 处/); assert.equal(picker(p).querySelectorAll('.mark').length, 2);
  pickerClick(p, '不翻译同类');
  await until(() => p.document.querySelectorAll('.author ' + MARK).length === 0);
  assert.equal(p.document.querySelectorAll('p ' + MARK).length, 2);
  const article = p.document.createElement('article'); article.innerHTML = '<div class="author">Example New Researcher</div><p>A new readable post from this researcher.</p>'; p.document.body.append(article);
  await until(() => article.querySelector('p ' + MARK));
  assert.equal(article.querySelector('.author ' + MARK), null);
  assert(!p.texts('LUNA_TRANSLATE').includes('Example New Researcher'));
  pickerClick(p, '撤销'); await until(() => p.document.querySelectorAll('.author ' + MARK).length === 3);
});

test('excluding inline names protects their text while continuing to translate surrounding paragraphs', async t => {
  const p = await page(t, { url: 'https://example.com', html: '<p id="prose">A thoughtful message from <a class="person" href="/person">Jane Example</a> discusses the next release.</p>', rules: [{ id: 'r', selector: 'a.person' }] });
  p.action('start'); await until(() => p.document.querySelector('#prose ' + MARK));
  assert(p.texts('LUNA_TRANSLATE').some(text => text.includes('__LUNA_KEEP_0__')));
  const text = p.document.querySelector(MARK).textContent;
  assert(text.includes('Jane Example')); assert(text.includes('discusses the next release')); assert(!text.includes('__LUNA_'));
  assert.equal(p.document.querySelector('a').getAttribute('href'), '/person');
});

test('a persisted inline-only exclusion does not translate or duplicate an entire nickname', async t => {
  const p = await page(t, { url: 'https://example.com', html: '<div><span class="nickname">A Long Nickname</span></div>', rules: [{ id: 'r', selector: 'span.nickname' }] });
  p.action('start'); await sleep(50);
  assert.equal(p.texts('LUNA_TRANSLATE').length, 0); assert.equal(p.document.querySelectorAll(MARK).length, 0);
});

test('exclusion suppresses in-flight replies and picker cancel never starts inference', async t => {
  const hold = deferred();
  const p = await page(t, { url: 'https://example.com', html: '<div class="author">Another Example Author</div>', gate: hold.promise });
  p.action('pick'); p.document.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(picker(p), undefined); assert.equal(p.texts('LUNA_TRANSLATE').length, 0);
  p.action('start'); await until(() => p.texts('LUNA_TRANSLATE').length === 1);
  p.action('pick'); p.document.querySelector('.author').click(); pickerClick(p, '只忽略');
  hold.resolve(); await sleep(60); assert.equal(p.document.querySelectorAll(MARK).length, 0);
});

test('generic extraction groups nested inline divs without inserting output into a horizontal metadata row', async t => {
  const p = await page(t, { url: 'https://example.com', html: '<div id="row" style="display:flex">A profile header with metadata</div><p id="body">A complete message <span>with emphasis</span><span style="display:inline"> and more words.</span></p>' });
  p.action('start'); await until(() => p.document.querySelector('#body ' + MARK));
  assert.equal(p.document.querySelector('#row ' + MARK), null);
  assert(p.texts('LUNA_TRANSLATE').includes('A complete message with emphasis and more words.'));
});

test('semantic paragraphs and headings remain readable when a site styles them with flex/grid', async t => {
  const p = await page(t, { url: 'https://example.com', html: '<p id="flex" style="display:flex">This complete article paragraph should remain readable.</p><h2 id="grid" style="display:grid">A genuine heading in a grid</h2>' });
  p.action('start'); await until(() => p.action('status').translated === 2);
  assert(p.document.querySelector('#flex > ' + MARK)); assert(p.document.querySelector('#grid > ' + MARK));
});

test('headings omit screen-reader-only anchor labels but preserve visible linked title text', async t => {
  // Authored reduced fixture for the sr-only link-label pattern observed on Vercel;
  // no article copy, site CSS bundle or icon artwork is bundled here.
  const html = `<style>.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border-width:0}</style>
    <h2 id="heading"><a href="#heading"><svg></svg><span class="sr-only">Copy link to heading</span></a>A clear <a href="/guide">article heading</a></h2>`;
  const p = await page(t, { url: 'https://example.com/article', html });
  const label = p.document.querySelector('.sr-only'), original = label.outerHTML;
  p.action('start'); await until(() => p.document.querySelector('#heading > ' + MARK));
  assert.deepEqual(p.texts('LUNA_CACHE'), ['A clear article heading']);
  assert.deepEqual(p.texts('LUNA_TRANSLATE'), ['A clear article heading']);
  assert(!p.document.querySelector(MARK).textContent.includes('Copy link'));
  assert.equal(label.outerHTML, original, 'Accessibility text stays in the original DOM');
  assert.equal(p.document.querySelector('a[href="/guide"]').textContent, 'article heading');
});

test('CSS clipping works without known class names and through a hidden ancestor', async t => {
  const html = `<h2 id="heading"><span style="position:absolute;clip-path:inset(50%);">Hidden helper label</span>Only the visible heading</h2>
    <div style="position:absolute;width:1px;height:1px;overflow:hidden"><p>Screen reader announcement only</p></div>
    <p id="normal"><span class="sr-only">A class name without clipping</span> remains visible prose.</p>`;
  const p = await page(t, { url: 'https://example.com', html });
  p.action('start'); await until(() => p.action('status').translated === 2);
  assert.deepEqual(p.texts('LUNA_TRANSLATE'), ['Only the visible heading', 'A class name without clipping remains visible prose.']);
});

test('a formerly clipped label is included when it actually becomes visible', async t => {
  const p = await page(t, { url: 'https://example.com', html: '<h2 id="heading"><span id="helper" style="position:absolute;clip:rect(0px,0px,0px,0px)">Visible prefix </span>The article heading</h2>' });
  p.action('start'); await until(() => p.document.querySelector(MARK));
  assert.equal(p.texts('LUNA_TRANSLATE')[0], 'The article heading');
  p.document.querySelector('#helper').removeAttribute('style');
  await until(() => p.document.querySelector(MARK)?.textContent.includes('Visible prefix'));
  assert(p.texts('LUNA_TRANSLATE').includes('Visible prefix The article heading'));
});
