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
async function page(t, { html = fixture, url = 'https://x.com/home', cached = false, gate } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  const { window } = dom;
  const observers = [], NativeMutationObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeMutationObserver {
    constructor(callback) { super(callback); observers.push(this); }
  };
  t.after(() => { observers.forEach(observer => observer.disconnect()); window.close(); });
  const calls = [], listeners = [];
  const bounds = { x: 0, y: 100, top: 100, bottom: 130, left: 0, right: 600, width: 600, height: 30 };
  window.HTMLElement.prototype.getClientRects = function () {
    return this.closest('[hidden]') || window.getComputedStyle(this).display === 'none' ? [] : [bounds];
  };
  window.HTMLElement.prototype.getBoundingClientRect = () => bounds;
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
          case 'LUNA_UI_CONFIG': return { ok: true, result: {} };
          case 'LUNA_RESTORE_CONFIG': return { ok: true, result: { target: 'zh-CN', restore: false } };
          case 'LUNA_REMEMBER': return { ok: true, result: { remembered: true } };
          case 'LUNA_CACHE': return { ok: true, result: { model: 'gpt-6-luna',
            translations: request.texts.map(text => cached ? { text: '缓存译文：' + text } : null) } };
          case 'LUNA_TRANSLATE':
            if (gate) await gate;
            return { ok: true, result: { model: 'gpt-6-luna', translations: request.texts.map(text => ({ text: '译文：' + text })) } };
          default: throw Error(`Unexpected content request: ${request.type}`);
        }
      },
    },
    storage: { onChanged: { addListener() {} } },
  };
  window.eval(source);
  const action = value => {
    let result;
    listeners[0]({ type: 'LUNA_PAGE', action: value, target: 'zh-CN' }, {}, value => { result = value; });
    return result;
  };
  return { window, document: window.document, calls, action,
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
  assert(inputs.includes('We discussed the next release with @fixture_team and kept every original link in place.'));
  assert(!inputs.some(text => /fixture_author|Example Researcher|minutes ago|Show more|Repost|People you|Trending/.test(text)));
  assert(!inputs.includes('@fixture_team'));
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
  assert(p.texts('LUNA_CACHE').some(text => text.includes('with @fixture_team and')));
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
  assert(p.texts('LUNA_TRANSLATE').includes('A revised message for @second_team remains one complete paragraph.'));
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
  assert(p.texts('LUNA_TRANSLATE').includes(original + expanded));
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
