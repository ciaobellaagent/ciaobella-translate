(() => {
  if (globalThis.__lunaTranslate) return;
  globalThis.__lunaTranslate = true;
  const MARK = 'data-luna-translation';
  const EXCLUDE = 'script,style,noscript,pre,code,kbd,textarea,input,select,button,svg,math,canvas,video,audio,nav,header,footer,[hidden],[contenteditable]:not([contenteditable="false"]),[translate="no"],[aria-hidden="true"],[data-luna-ui],[' + MARK + ']';
  const TEXT_EXCLUDE = EXCLUDE.replace('pre,code,kbd,', 'pre,');
  const CANDIDATES = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,dd,dt,figcaption,div,section,article';
  let running = false, busy = false, preparing = false, epoch = 0, target = 'zh-CN', errorText = '', scanTimer;
  let cacheOnly = false, remembered = false, activePage = '', lastHref = location.href;
  let restoreRevision = 0;
  const records = new Map();
  const dirtyRoots = new Set();
  const ownRemovals = new WeakSet();
  let host, badge, label, detail, restore;
  let uiConfig = { side: 'right', vertical: 0.5, autoHide: true, showLauncher: true };

  function positionButton() {
    if (!host) return;
    host.dataset.side = uiConfig.side;
    host.dataset.autohide = String(uiConfig.autoHide);
    host.style.setProperty('--luna-top', Math.max(12, Math.min(innerHeight - 54, innerHeight * uiConfig.vertical - 21)) + 'px');
    host.hidden = !uiConfig.showLauncher;
  }

  function applyUI(config = {}) {
    if (['left', 'right'].includes(config.side)) uiConfig.side = config.side;
    if (Number.isFinite(config.vertical) && config.vertical >= 0 && config.vertical <= 1) uiConfig.vertical = config.vertical;
    for (const key of ['autoHide', 'showLauncher']) if (typeof config[key] === 'boolean') uiConfig[key] = config[key];
    positionButton();
  }

  function sourceText(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        if (node.parentElement?.closest(TEXT_EXCLUDE)) return NodeFilter.FILTER_REJECT;
        // Each block owns only its text outside nested blocks. Mixed containers
        // can retain their direct text while new child paragraphs translate once.
        if (node.parentElement?.closest(CANDIDATES) !== element) return NodeFilter.FILTER_REJECT;
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          if (parent === element) break;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = '', node;
    while ((node = walker.nextNode())) text += node.textContent;
    return text.replace(/\s+/g, ' ').trim();
  }

  function needsTranslation(text) {
    if (text.length < 8 || !/\p{L}/u.test(text)) return false;
    const letters = text.match(/\p{L}/gu)?.length || 1;
    const chinese = text.match(/\p{Script=Han}/gu)?.length || 0;
    if (target.startsWith('zh') && chinese / letters > 0.7) return false;
    if (target === 'en' && /^[\x00-\x7f\s“”‘’—–…]+$/.test(text)) return false;
    return true;
  }

  function parts(text, limit = 2800) {
    const result = [];
    while (text.length > limit) {
      let cut = Math.max(text.lastIndexOf('. ', limit), text.lastIndexOf('。', limit), text.lastIndexOf(' ', limit));
      if (cut < limit / 2) cut = limit;
      else cut++;
      result.push(text.slice(0, cut)); text = text.slice(cut);
    }
    if (text) result.push(text);
    return result;
  }

  function makeBadge() {
    if (host?.isConnected) return;
    host = document.createElement('div'); host.dataset.lunaUi = 'launcher';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host{all:initial!important;position:fixed!important;right:0!important;left:auto!important;top:var(--luna-top,calc(50% - 21px))!important;transform:none!important;z-index:2147483646!important;pointer-events:none!important;color-scheme:light}
      :host([hidden]){display:none!important}:host([data-side=left]){left:0!important;right:auto!important}:host([data-dragging=true]){left:var(--luna-drag-left)!important;right:auto!important}
      *{box-sizing:border-box}.shell{position:relative;pointer-events:auto;font:12px/1.5 'PingFang SC','Hiragino Sans GB',sans-serif}
      button{font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #b72c26;outline-offset:4px}
      .trigger{position:relative;display:grid;place-items:center;width:42px;height:42px;padding:0;border:1px solid #d9d2c9;border-radius:14px;background:#faf7f1;color:#141414;box-shadow:0 3px 16px #1414141c;transition:transform .18s,box-shadow .18s;touch-action:none;user-select:none}
      .trigger:hover{box-shadow:0 4px 20px #1414142b}.glyph{display:block;width:40px;height:40px;border-radius:13px;pointer-events:none}
      :host([data-autohide=true]) .trigger{transform:translateX(12px)}:host([data-side=left][data-autohide=true]) .trigger{transform:translateX(-12px)}
      :host([data-autohide=true]) .glyph{width:28px;height:28px;border-radius:8px;transform:translateX(-6px)}:host([data-side=left][data-autohide=true]) .glyph{transform:translateX(6px)}
      .shell:hover .trigger,.shell:focus-within .trigger,:host([data-dragging=true]) .trigger{transform:none!important}
      .shell:hover .glyph,.shell:focus-within .glyph,:host([data-dragging=true]) .glyph{width:40px;height:40px;border-radius:13px;transform:none!important}
      .activity{display:none;position:absolute;left:0;top:-3px;width:13px;height:13px;border:2px solid #ead2cf;border-top-color:#b72c26;border-radius:50%;background:#faf7f1;animation:luna-spin .85s linear infinite}:host([data-side=left]) .activity{left:auto;right:0}
      .panel{display:none;align-items:center;gap:10px;position:absolute;right:49px;top:50%;transform:translateY(-50%);width:max-content;max-width:min(340px,calc(100vw - 65px));padding:10px 12px 10px 15px;border:1px solid #e0d9d0;border-radius:14px;background:#faf7f1;color:#141414;box-shadow:0 4px 22px #14141414}
      .panel:after{content:'';position:absolute;right:-12px;top:0;width:14px;height:100%}:host([data-side=left]) .panel{right:auto;left:49px}:host([data-side=left]) .panel:after{right:auto;left:-12px}
      .shell:hover .panel,.shell:focus-within .panel{display:flex}:host([data-dragging=true]) .panel{display:none}
      .label{font-size:13px;font-weight:600;white-space:nowrap}.detail{margin-top:2px;color:#6b655d;font-size:11px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
      .restore,.settings-button{flex:none;width:29px;height:29px;border:0;border-radius:9px;background:#eee8df;color:#141414;font-size:20px;line-height:1}.settings-button{font-size:17px}.restore:hover,.settings-button:hover{background:#e6ded3}[hidden]{display:none!important}
      :host([data-state=running]) .trigger,:host([data-state=preparing]) .trigger{border-color:#b72c26}
      :host([data-working=true]) .activity{display:block}:host([data-state=error]) .trigger{border-color:#b72c26;box-shadow:0 0 0 2px #b72c2626}
      :host([data-state=error]) .label{color:#b72c26}@keyframes luna-spin{to{transform:rotate(360deg)}}
      @media(prefers-reduced-motion:reduce){.activity{animation:none}.trigger{transition:none}}
      @media(max-width:600px){.panel{max-width:calc(100vw - 62px);gap:6px;padding:9px}.label{white-space:normal}}
    `;
    const shell = document.createElement('div'); shell.className = 'shell';
    const panel = document.createElement('div'); panel.className = 'panel';
    const copy = document.createElement('div');
    label = document.createElement('div'); label.className = 'label'; label.setAttribute('role', 'status'); label.setAttribute('aria-live', 'polite');
    detail = document.createElement('div'); detail.className = 'detail';
    copy.append(label, detail);
    restore = document.createElement('button'); restore.className = 'restore'; restore.type = 'button'; restore.textContent = '↶';
    restore.title = '恢复原文'; restore.setAttribute('aria-label', '恢复原文'); restore.addEventListener('click', reset);
    const settingsButton = document.createElement('button'); settingsButton.className = 'settings-button'; settingsButton.type = 'button';
    settingsButton.textContent = '⚙'; settingsButton.title = '阅读设置'; settingsButton.setAttribute('aria-label', '打开阅读设置');
    settingsButton.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'LUNA_OPEN_SETTINGS' }).catch(() => {}));
    panel.append(copy, restore, settingsButton);
    badge = document.createElement('button'); badge.type = 'button';
    badge.className = 'trigger';
    const glyph = document.createElement('img'); glyph.className = 'glyph'; glyph.alt = ''; glyph.draggable = false;
    if (chrome.runtime.getURL) glyph.src = chrome.runtime.getURL('icons/bella.png');
    const activity = document.createElement('span'); activity.className = 'activity'; activity.setAttribute('aria-hidden', 'true');
    badge.append(glyph, activity);
    let drag, suppressClick = false;
    badge.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      suppressClick = false; drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      badge.setPointerCapture(event.pointerId);
    });
    badge.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
      drag.moved = true; host.dataset.dragging = 'true';
      host.style.setProperty('--luna-drag-left', Math.max(0, Math.min(innerWidth - 42, event.clientX - 21)) + 'px');
      host.style.setProperty('--luna-top', Math.max(12, Math.min(innerHeight - 54, event.clientY - 21)) + 'px');
    });
    const finishDrag = event => {
      if (!drag || drag.id !== event.pointerId) return;
      if (drag.moved) {
        suppressClick = true;
        const vertical = Math.max(0, Math.min(1, (host.getBoundingClientRect().top + 21) / Math.max(1, innerHeight)));
        const side = event.clientX < innerWidth / 2 ? 'left' : 'right';
        applyUI({ side, vertical });
        chrome.runtime.sendMessage({ type: 'LUNA_FLOAT_SAVE', side, vertical }).catch(() => {});
      }
      host.dataset.dragging = 'false'; drag = null;
    };
    badge.addEventListener('pointerup', finishDrag);
    badge.addEventListener('pointercancel', () => { suppressClick = true; drag = null; host.dataset.dragging = 'false'; positionButton(); });
    badge.addEventListener('lostpointercapture', () => { host.dataset.dragging = 'false'; drag = null; });
    badge.addEventListener('click', () => { if (suppressClick) { suppressClick = false; return; } if ((running && !cacheOnly) || preparing) stop(); else startFromPage(); });
    shell.append(panel, badge); shadow.append(style, shell); document.documentElement.append(host);
    positionButton();
  }

  function status() {
    const all = [...records.values()].filter(r => r.element.isConnected);
    return { running, busy, preparing, cacheOnly, target, translated: all.filter(r => r.state === 'done').length,
      cached: all.filter(r => r.state === 'done' && r.fromCache).length,
      checking: all.filter(r => r.state === 'checking').length,
      translating: all.filter(r => r.state === 'translating').length,
      queued: all.filter(r => r.progress?.dataset.lunaProgress === 'queued').length, total: all.length, error: errorText };
  }

  function update() {
    if (!badge) return;
    syncProgress();
    const state = status();
    host.dataset.state = errorText ? 'error' : preparing ? 'preparing' : running ? cacheOnly ? 'restored' : 'running' : state.total ? 'paused' : 'idle';
    host.dataset.working = String(preparing || (running && state.translating > 0));
    const action = errorText ? '点击重试翻译' : running && cacheOnly ? '点击翻译新内容' : running || preparing ? '点击暂停翻译' : state.total ? '点击继续翻译' : '点击翻译此页';
    badge.title = errorText ? `${errorText} · ${action}` : `Luna · ${action}`;
    badge.setAttribute('aria-label', badge.title); badge.setAttribute('aria-pressed', String((running && !cacheOnly) || preparing));
    const heading = errorText ? '翻译已暂停 · 点击重试' : preparing ? '准备翻译…' : running ?
      cacheOnly ? `已恢复 ${state.cached} 段缓存` : state.translating ? `正在翻译 ${state.translating} 段` :
      state.checking ? '读取已有译文…' : state.queued ? `等待翻译 ${state.queued} 段` : '跟随阅读 · 点击暂停' :
      state.total ? '已暂停 · 点击继续' : '翻译此页';
    const description = errorText || (preparing ? '正在读取翻译设置' : running ?
      cacheOnly ? '滚动复用缓存 · 点击图标翻译新内容' :
      `已译 ${state.translated} 段${state.cached ? ` · 复用 ${state.cached} 段` : ''}${state.queued ? ` · 等待 ${state.queued} 段` : ' · 滚动继续翻译'}` :
      state.total ? `已译 ${state.translated} 段 · 原文与译文保留` : 'Luna · 保留原文，双语阅读');
    if (label.textContent !== heading) label.textContent = heading;
    if (detail.textContent !== description) detail.textContent = description;
    restore.hidden = !state.total && !errorText && !preparing;
  }

  async function startFromPage() {
    if (preparing) return;
    checkPage();
    const mine = epoch; preparing = true; errorText = ''; update();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'LUNA_PAGE_CONFIG' });
      if (mine !== epoch) return;
      if (!response?.ok) throw new Error(response?.error || '无法读取翻译设置。');
      start(response.result.target);
    } catch (error) {
      if (mine === epoch) { errorText = error.message; update(); }
    } finally {
      if (mine === epoch) { preparing = false; update(); }
    }
  }

  // Viewport prefetch and incremental-observation design references (KISS and
  // open-immersive-translate) are identified in ACKNOWLEDGEMENTS.md. This code
  // retains source DOM and owns its own scheduling/cancellation semantics.
  const viewport = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = records.get(entry.target);
      if (record) record.visible = entry.isIntersecting;
    }
    update(); pump();
  }, { rootMargin: '500px 0px' });

  function removeTranslation(record) {
    if (record.node) { ownRemovals.add(record.node); record.node.remove(); }
  }

  function removeProgress(record) {
    if (record.progress) { ownRemovals.add(record.progress); record.progress.remove(); record.progress = null; }
  }

  function isNearby(record) {
    const element = record.element;
    if (!record.visible || !element.isConnected || element.closest(EXCLUDE) ||
        element.getClientRects().length === 0 || getComputedStyle(element).visibility === 'hidden') return false;
    const box = element.getBoundingClientRect();
    return box.bottom >= -500 && box.top <= innerHeight + 500;
  }

  function syncProgress() {
    for (const record of records.values()) {
      if (!running || cacheOnly || errorText || record.state === 'done' || !isNearby(record)) { removeProgress(record); continue; }
      const phase = record.state === 'translating' ? 'translating' : 'queued';
      if (!record.progress?.isConnected || record.progress.parentElement !== record.element) {
        removeProgress(record);
        const node = document.createElement('span'); node.dataset.lunaUi = 'progress';
        node.style.cssText = 'display:inline-flex!important;vertical-align:middle!important;margin-inline-start:0.55em!important;width:14px!important;height:14px!important;line-height:1!important;';
        node.setAttribute('role', 'img');
        const shadow = node.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = ':host{color:#b72c26}.ring{display:block;width:12px;height:12px;box-sizing:border-box;border:1.5px dotted currentColor;border-radius:50%;opacity:.55}:host([data-luna-progress=translating]) .ring{border-style:solid;border-color:#b72c2635;border-top-color:#b72c26;opacity:1;animation:luna-turn .8s linear infinite}@keyframes luna-turn{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.ring{animation:none!important}}';
        const ring = document.createElement('span'); ring.className = 'ring';
        shadow.append(style, ring); record.element.append(node); record.progress = node;
      }
      if (record.progress.dataset.lunaProgress !== phase) {
        record.progress.dataset.lunaProgress = phase;
        const description = phase === 'translating' ? 'Luna 正在翻译…' : 'Luna 等待翻译…';
        record.progress.title = description; record.progress.setAttribute('aria-label', description);
      }
    }
  }

  function scan(roots = [document.body]) {
    if (checkPage() || !running || !document.body) return;
    const candidates = new Set();
    for (const root of roots) {
      if (root.matches?.(CANDIDATES)) candidates.add(root);
      root.querySelectorAll?.(CANDIDATES).forEach(element => candidates.add(element));
      for (let parent = root.parentElement; parent; parent = parent.parentElement) {
        if (records.has(parent)) candidates.add(parent);
      }
    }
    for (const [element, record] of records) {
      if (!element.isConnected) { removeProgress(record); viewport.unobserve(element); records.delete(element); continue; }
      if (!candidates.has(element)) continue;
      if (element.closest(EXCLUDE) || element.getClientRects().length === 0) {
        removeProgress(record); removeTranslation(record); viewport.unobserve(element); records.delete(element); continue;
      }
      const text = sourceText(element);
      if (!needsTranslation(text)) {
        removeProgress(record); removeTranslation(record); viewport.unobserve(element); records.delete(element); continue;
      }
      if (text !== record.source) {
        removeProgress(record); removeTranslation(record); record.node = null; record.source = text;
        record.state = 'pending'; record.parts = parts(text); record.result = []; record.cachedParts.clear(); record.cacheMisses.clear(); record.revision++;
      } else if (record.state === 'done' && (!record.node?.isConnected || record.node.parentElement !== element)) {
        // Frameworks can replace a block's children without changing the source.
        render(record);
      }
    }
    for (const element of candidates) {
      if (records.has(element) || element.closest(EXCLUDE)) continue;
      // Keep inline links and emphasis; sourceText excludes nested block content.
      if (element.getClientRects().length === 0 || getComputedStyle(element).visibility === 'hidden') continue;
      const text = sourceText(element);
      if (!needsTranslation(text)) continue;
      const record = { element, source: text, parts: parts(text), result: [], cachedParts: new Set(), cacheMisses: new Set(), state: 'pending', visible: false, revision: 0 };
      records.set(element, record); viewport.observe(element);
    }
    update(); pump();
  }

  function render(record) {
    removeProgress(record); removeTranslation(record);
    const node = document.createElement('span'); node.setAttribute(MARK, ''); node.lang = target;
    node.style.cssText = 'display:block!important;margin:0.55em 0 0.8em!important;padding:0.1em 0 0.1em 0.85em!important;border-left:2px solid #b72c2660!important;color:inherit!important;opacity:0.91!important;font-size:0.96em!important;line-height:1.75!important;font-weight:400!important;white-space:pre-wrap!important;text-align:start!important;';
    node.textContent = record.result.join('');
    record.element.append(node); record.node = node; record.state = 'done';
    record.fromCache = record.parts.every((_, index) => record.cachedParts.has(index));
    if (!cacheOnly && !remembered && activePage === pageIdentity()) {
      remembered = true; const mine = epoch;
      chrome.runtime.sendMessage({ type: 'LUNA_REMEMBER', target }).then(response => {
        if (!response?.ok && mine === epoch) remembered = false;
      }).catch(() => { if (mine === epoch) remembered = false; });
    }
  }

  async function pump() {
    if (checkPage() || !running || busy || errorText) return;
    const jobs = [];
    let characters = 0;
    for (const record of records.values()) {
      if (record.state === 'done' || !isNearby(record)) continue;
      for (let index = 0; index < record.parts.length; index++) {
        if (record.result[index] || (cacheOnly && record.cacheMisses.has(index))) continue;
        const text = record.parts[index];
        if (jobs.length >= 12 || characters + text.length > 6000) break;
        jobs.push({ record, index, text, revision: record.revision }); characters += text.length;
      }
      if (jobs.length >= 12 || characters >= 5500) break;
    }
    if (!jobs.length) return;
    for (const { record } of jobs) record.state = 'checking';
    busy = true; update();
    const mine = epoch, language = target;
    const valid = ({ record, revision }) => records.get(record.element) === record && record.element.isConnected &&
      record.revision === revision && sourceText(record.element) === record.source;
    const apply = ({ record, index }, text, cached) => {
      record.result[index] = text;
      if (cached) record.cachedParts.add(index);
      if (record.parts.every((_, part) => Boolean(record.result[part]))) render(record);
    };
    try {
      const cached = await chrome.runtime.sendMessage({ type: 'LUNA_CACHE', target: language, texts: jobs.map(job => job.text) });
      if (checkPage() || mine !== epoch || !running) return;
      if (!cached?.ok || cached.result?.model !== 'gpt-6-luna' || cached.result.translations?.length !== jobs.length ||
          cached.result.translations.some(item => item !== null && (typeof item?.text !== 'string' || !item.text.trim()))) {
        throw new Error(cached?.error || '无法读取本地译文缓存。');
      }
      const missing = [];
      jobs.forEach((job, index) => {
        if (!valid(job)) return;
        const hit = cached.result.translations[index];
        if (hit) apply(job, hit.text, true);
        else if (cacheOnly) job.record.cacheMisses.add(job.index);
        else if (isNearby(job.record)) missing.push(job);
      });
      if (cacheOnly || !missing.length) return;
      for (const { record } of missing) record.state = 'translating';
      update();
      const response = await chrome.runtime.sendMessage({ type: 'LUNA_TRANSLATE', target: language, texts: missing.map(job => job.text) });
      if (checkPage() || mine !== epoch || !running) return;
      if (!response?.ok) throw new Error(response?.error || '翻译失败。');
      const texts = response.result.translations;
      if (texts.length !== missing.length || response.result.model !== 'gpt-6-luna' ||
          texts.some(item => typeof item?.text !== 'string' || !item.text.trim())) throw new Error('翻译结果或模型不匹配。');
      missing.forEach((job, index) => {
        if (valid(job)) apply(job, texts[index].text, false);
      });
    } catch (error) {
      if (mine === epoch) { stop(); errorText = error.message; }
    } finally {
      for (const { record, revision } of jobs) {
        if (record.revision === revision && ['translating', 'checking'].includes(record.state)) record.state = 'pending';
      }
      busy = false; update();
      if (running) setTimeout(pump, 50);
    }
  }

  function start(language = target, restoreOnly = false) {
    checkPage();
    if (language !== target) { reset(); target = language; }
    epoch++;
    cacheOnly = restoreOnly; remembered = restoreOnly; activePage = pageIdentity();
    for (const record of records.values()) { record.cacheMisses.clear(); if (record.state !== 'done') record.state = 'pending'; }
    preparing = false; running = true; errorText = ''; makeBadge();
    for (const record of records.values()) { if (record.node) record.node.hidden = false; viewport.observe(record.element); }
    scan(); update(); return status();
  }

  function stop() {
    preparing = false; running = false; epoch++; viewport.disconnect(); clearTimeout(scanTimer); scanTimer = null;
    for (const record of records.values()) if (['translating', 'checking'].includes(record.state)) record.state = 'pending';
    dirtyRoots.clear(); update(); return status();
  }

  function reset() {
    stop();
    for (const record of records.values()) { removeProgress(record); removeTranslation(record); }
    records.clear(); cacheOnly = false; errorText = ''; update(); return status();
  }

  function pageIdentity() {
    const url = new URL(location.href);
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(?:gclid|fbclid)$/i.test(key)) url.searchParams.delete(key);
    url.search = url.searchParams.toString();
    return url.href;
  }

  let lastPage = pageIdentity();
  function checkPage() {
    if (lastHref === location.href) return false;
    lastHref = location.href;
    const page = pageIdentity();
    if (page === lastPage) return false;
    lastPage = page; reset(); restoreFromHistory(); return true;
  }

  async function restoreFromHistory() {
    const mine = epoch, page = pageIdentity(), revision = restoreRevision;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'LUNA_RESTORE_CONFIG' });
      if (mine === epoch && revision === restoreRevision && !running && !preparing && page === pageIdentity() && response?.ok && response.result.restore) start(response.result.target, true);
    } catch { /* A new page stays idle when local history is unavailable. */ }
  }

  function ownNode(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return element?.closest(`[${MARK}],[data-luna-ui]`);
  }

  function queueScan(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element || ownNode(element)) return;
    let root = element.matches(CANDIDATES) || element.querySelector(CANDIDATES) ? element :
      element.closest(CANDIDATES) || element;
    // Include an existing parent record when its directly owned text changes.
    for (let parent = root.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
      if (records.has(parent)) { root = parent; break; }
    }
    dirtyRoots.add(root);
    if (scanTimer) return;
    // A bounded coalescing window still flushes on continuously updating pages.
    scanTimer = setTimeout(() => {
      scanTimer = null;
      const roots = [...dirtyRoots].filter(root => root.isConnected);
      dirtyRoots.clear();
      const changed = new Set(roots);
      scan(roots.filter(root => {
        for (let parent = root.parentElement; parent; parent = parent.parentElement) {
          if (changed.has(parent)) return false;
        }
        return true;
      }));
    }, 150);
  }

  new MutationObserver(mutations => {
    if (checkPage()) return;
    if (!host?.isConnected) { makeBadge(); update(); }
    if (!running) return;
    for (const mutation of mutations) {
      if (ownNode(mutation.target)) continue;
      if (mutation.type === 'childList') {
        // A framework may remove only our span. Restore it without another request;
        // ignore removals made by render/reset themselves to avoid observer loops.
        if ([...mutation.addedNodes].every(ownNode) &&
            [...mutation.removedNodes].every(node => ownRemovals.has(node) ||
              (ownNode(node) && records.get(mutation.target)?.node !== node &&
                records.get(mutation.target)?.progress !== node))) continue;
      }
      queueScan(mutation.target);
    }
  }).observe(document.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['open', 'hidden', 'class', 'style', 'aria-expanded', 'aria-hidden'],
  });
  document.addEventListener('toggle', event => {
    if (running && event.target.tagName === 'DETAILS') queueScan(event.target);
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type !== 'LUNA_PAGE') return;
    const action = message.action;
    const result = action === 'start' ? start(message.target) : action === 'pause' ? stop() :
      action === 'reset' ? reset() : action === 'toggle' ? ((running && !cacheOnly) || preparing ? stop() : start(message.target)) : status();
    respond(result);
  });
  // Only previously translated pages may scan for cache-only restoration.
  // New pages mount the control; neither path starts inference automatically.
  makeBadge(); update();
  chrome.runtime.sendMessage({ type: 'LUNA_UI_CONFIG' }).then(response => { if (response?.ok) applyUI(response.result); }).catch(() => {});
  window.addEventListener('resize', positionButton, { passive: true });
  window.addEventListener('popstate', checkPage);
  window.addEventListener('hashchange', checkPage);
  window.navigation?.addEventListener('currententrychange', checkPage);
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) applyUI(changes.settings.newValue);
    if (changes.bridgeRevision) { restoreRevision++; reset(); return; }
    if (!changes.settings || (changes.settings.oldValue?.target === changes.settings.newValue?.target &&
        changes.settings.oldValue?.autoRestore === changes.settings.newValue?.autoRestore)) return;
    restoreRevision++;
    if (cacheOnly) reset();
    if (!running && !preparing) restoreFromHistory();
  });
  restoreFromHistory();
})();
