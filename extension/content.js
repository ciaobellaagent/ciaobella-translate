(() => {
  if (globalThis.__lunaTranslate) return;
  globalThis.__lunaTranslate = true;
  const MARK = 'data-luna-translation';
  const EXCLUDE = 'script,style,noscript,pre,code,kbd,textarea,input,select,button,svg,math,canvas,video,audio,nav,header,footer,[hidden],[contenteditable]:not([contenteditable="false"]),[translate="no"],[aria-hidden="true"],[data-luna-ui],[' + MARK + ']';
  const TEXT_EXCLUDE = EXCLUDE.replace('pre,code,kbd,', 'pre,');
  const ON_X = /(^|\.)(x\.com|twitter\.com)$/.test(location.hostname);
  // X uses nested divs for inline mentions and its author row. Only readable
  // regions own translations; atomic post/bio roots retain their inline text.
  // These selectors and the synthetic test fixture are independently authored.
  const X_ATOMIC = '[data-testid="tweetText"],[data-testid="UserDescription"]';
  const X_ARTICLE = '[data-testid="longformRichTextComponent"]';
  const X_METADATA = '[data-testid="User-Name"],[data-testid="UserName"],[data-testid="socialContext"],time,[role="button"]';
  const CANDIDATES = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,dd,dt,figcaption,div,section,article' + (ON_X ? ',' + X_ATOMIC : '');
  let running = false, preparing = false, epoch = 0, target = 'zh-CN', errorText = '', scanTimer;
  let cacheOnly = false, remembered = false, activePage = '', lastHref = location.href;
  let restoreRevision = 0;
  const records = new Map();
  const batches = new Map();
  let concurrency = 12, selectedModel = 'gpt-6-luna', selectedEffort = 'medium';
  let siteRules = [], rulesLoaded = false;
  const ignoredNodes = new Set();
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

  function eligible(element) {
    if (element.closest(EXCLUDE) || ignored(element)) return false;
    if (!ON_X) {
      if (element.closest('a,[role="button"],[role="menuitem"]')) return false;
      const display = getComputedStyle(element).display;
      return display !== 'inline' && (element.matches('p,h1,h2,h3,h4,h5,h6,blockquote,li,td,th,dd,dt,figcaption') || !/^(inline-)?(flex|grid)$/.test(display));
    }
    if (element.closest(X_METADATA)) return false;
    const atomic = element.closest(X_ATOMIC);
    return atomic ? atomic === element : Boolean(element.closest(X_ARTICLE));
  }

  function ignored(element) {
    for (const node of ignoredNodes) if (node === element || node.contains(element)) return true;
    return siteRules.some(rule => { try { return Boolean(element.closest(rule.selector)); } catch { return false; } });
  }

  function textOwner(element) {
    if (ON_X) return element.closest(X_ATOMIC) || element.closest(CANDIDATES);
    for (let current = element; current; current = current.parentElement) {
      if (current.matches(CANDIDATES) && getComputedStyle(current).display !== 'inline') return current;
    }
    return null;
  }

  function sourceText(element, kept) {
    const atomic = ON_X && element.matches(X_ATOMIC);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: node => {
        if (node.parentElement?.closest(TEXT_EXCLUDE) || (ON_X && node.parentElement?.closest(X_METADATA))) return NodeFilter.FILTER_REJECT;
        // Each block owns only its text outside nested blocks. Mixed containers
        // retain direct text; X post/bio roots instead own nested inline divs.
        const owner = atomic ? node.parentElement?.closest(X_ATOMIC) : textOwner(node.parentElement);
        if (owner !== element) return NodeFilter.FILTER_REJECT;
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          if (parent === element) break;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let text = '', node;
    const protect = value => {
      let token = `__LUNA_KEEP_${kept.length}__`;
      while (element.textContent.includes(token) || kept.some(item => item.token === token)) token = token.replace('__LUNA_KEEP_', '__LUNA_KEEP_X');
      kept.push({ token, value }); return token;
    };
    while ((node = walker.nextNode())) {
      let value = node.textContent;
      if (kept) value = ignored(node.parentElement) ? protect(value) : value.replace(/(?<![\w@])@[A-Za-z0-9_]{1,30}\b/g, protect);
      text += value;
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  function prepareRecord(record) {
    record.kept = []; record.claims = new Map();
    record.parts = parts(sourceText(record.element, record.kept));
  }

  function hasTranslatableContent(element) {
    const kept = [];
    let text = sourceText(element, kept);
    for (const item of kept) text = text.split(item.token).join('');
    return needsTranslation(text);
  }

  function needsTranslation(text) {
    if (/^@[\p{L}\p{N}_]+$/u.test(text)) return false;
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
      for (const match of text.matchAll(/__LUNA_KEEP_[A-Z0-9]+__/g)) {
        if (match.index < cut && match.index + match[0].length > cut) { cut = match.index || match[0].length; break; }
        if (match.index >= cut) break;
      }
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
    const excludeButton = document.createElement('button'); excludeButton.className = 'settings-button'; excludeButton.type = 'button';
    excludeButton.textContent = '⊘'; excludeButton.title = '选择不翻译的内容'; excludeButton.setAttribute('aria-label', excludeButton.title);
    excludeButton.addEventListener('click', startPicker);
    panel.append(copy, excludeButton, restore, settingsButton);
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
    return { running, busy: batches.size > 0, activeBatches: batches.size, concurrency, preparing, cacheOnly, target, translated: all.filter(r => r.state === 'done').length,
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
      applyScheduler(response.result); start(response.result.target);
    } catch (error) {
      if (mine === epoch) { errorText = error.message; update(); }
    } finally {
      if (mine === epoch) { preparing = false; update(); }
    }
  }

  // Viewport prefetch and incremental-observation design references (KISS and
  // open-immersive-translate) are identified in ACKNOWLEDGEMENTS.md. This code
  // retains source DOM and owns its own scheduling/cancellation semantics.
  let pumpTimer;
  function schedulePump() { if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, 16); }
  const viewport = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = records.get(entry.target);
      if (record) record.visible = entry.isIntersecting;
    }
    update(); schedulePump();
  }, { rootMargin: '500px 0px' });

  function removeTranslation(record) {
    if (record.node) { ownRemovals.add(record.node); record.node.remove(); }
  }

  function removeProgress(record) {
    if (record.progress) { ownRemovals.add(record.progress); record.progress.remove(); record.progress = null; }
  }

  function isNearby(record) {
    const element = record.element;
    if (!record.visible || !element.isConnected || !eligible(element) ||
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
      if (!eligible(element) || element.getClientRects().length === 0) {
        removeProgress(record); removeTranslation(record); viewport.unobserve(element); records.delete(element); continue;
      }
      const text = sourceText(element);
      if (!needsTranslation(text) || !hasTranslatableContent(element)) {
        removeProgress(record); removeTranslation(record); viewport.unobserve(element); records.delete(element); continue;
      }
      if (text !== record.source) {
        removeProgress(record); removeTranslation(record); record.node = null; record.source = text;
        record.state = 'pending'; prepareRecord(record); record.result = []; record.cachedParts.clear(); record.cacheMisses.clear(); record.revision++;
      } else if (record.state === 'done' && (!record.node?.isConnected || record.node.parentElement !== element)) {
        // Frameworks can replace a block's children without changing the source.
        render(record);
      }
    }
    for (const element of candidates) {
      if (records.has(element) || !eligible(element)) continue;
      // Keep inline links and emphasis; sourceText excludes nested block content.
      if (element.getClientRects().length === 0 || getComputedStyle(element).visibility === 'hidden') continue;
      const text = sourceText(element);
      if (!needsTranslation(text) || !hasTranslatableContent(element)) continue;
      const record = { element, source: text, parts: parts(text), result: [], cachedParts: new Set(), cacheMisses: new Set(), state: 'pending', visible: false, revision: 0 };
      prepareRecord(record); records.set(element, record); viewport.observe(element);
    }
    update(); schedulePump();
  }

  function render(record) {
    removeProgress(record); removeTranslation(record);
    const node = document.createElement('span'); node.setAttribute(MARK, ''); node.lang = target;
    node.style.cssText = 'display:block!important;margin:0.55em 0 0.8em!important;padding:0.1em 0 0.1em 0.85em!important;border-left:2px solid #b72c2660!important;color:inherit!important;opacity:0.91!important;font-size:0.96em!important;line-height:1.75!important;font-weight:400!important;white-space:pre-wrap!important;text-align:start!important;';
    let translated = record.result.join('');
    for (const { token, value } of record.kept) translated = translated.split(token).join(value);
    node.textContent = translated;
    record.element.append(node); record.node = node; record.state = 'done';
    record.fromCache = record.parts.every((_, index) => record.cachedParts.has(index));
    if (!cacheOnly && !remembered && activePage === pageIdentity()) {
      remembered = true; const mine = epoch;
      chrome.runtime.sendMessage({ type: 'LUNA_REMEMBER', target }).then(response => {
        if (!response?.ok && mine === epoch) remembered = false;
      }).catch(() => { if (mine === epoch) remembered = false; });
    }
  }

  function applyScheduler(config = {}) {
    if ((config.model && config.model !== selectedModel) || (config.effort && config.effort !== selectedEffort)) reset();
    if (Number.isInteger(config.concurrency) && config.concurrency >= 1 && config.concurrency <= 24) concurrency = config.concurrency;
    if (config.model) selectedModel = config.model;
    if (config.effort) selectedEffort = config.effort;
  }

  function priority(record) {
    const box = record.element.getBoundingClientRect();
    return box.bottom >= 0 && box.top <= innerHeight ? 0 : 1;
  }

  function cancelBatch(id, batch) {
    batch.cancelled = true; batches.delete(id);
    for (const { record, index } of batch.jobs) {
      if (record.claims.get(index) === id) { record.claims.delete(index); if (record.state !== 'done') record.state = 'pending'; }
    }
    chrome.runtime.sendMessage({ type: 'LUNA_CANCEL', requestId: id }).catch(() => {});
  }

  function pump() {
    if (checkPage() || !running || !rulesLoaded || errorText) return;
    for (const [id, batch] of batches) {
      if (batch.jobs.every(job => !isNearby(job.record) || records.get(job.record.element) !== job.record || job.revision !== job.record.revision)) cancelBatch(id, batch);
    }
    while (batches.size < concurrency) {
      const jobs = []; let characters = 0, rank;
      const ordered = [...records.values()].filter(record => record.state !== 'done' && isNearby(record))
        .sort((a, b) => priority(a) - priority(b));
      for (const record of ordered) {
        if (rank !== undefined && priority(record) !== rank) break;
        for (let index = 0; index < record.parts.length; index++) {
          if (record.result[index] || record.claims.has(index) || (cacheOnly && record.cacheMisses.has(index))) continue;
          const text = record.parts[index];
          if (jobs.length >= 4 || (jobs.length && characters + text.length > 6000)) break;
          rank = priority(record); jobs.push({ record, index, text, revision: record.revision }); characters += text.length;
        }
        if (jobs.length >= 4 || characters >= 5500) break;
      }
      if (!jobs.length) break;
      const id = crypto.randomUUID();
      for (const { record, index } of jobs) { record.claims.set(index, id); record.state = 'checking'; }
      const batch = { jobs, cancelled: false }; batches.set(id, batch);
      executeBatch(id, batch, rank);
    }
    update();
  }

  async function executeBatch(id, batch, rank) {
    const { jobs } = batch;
    const mine = epoch, language = target, model = selectedModel, effort = selectedEffort;
    const valid = ({ record, index, revision }) => record.claims.get(index) === id && records.get(record.element) === record &&
      record.element.isConnected && eligible(record.element) && record.revision === revision && sourceText(record.element) === record.source;
    const stale = () => checkPage() || mine !== epoch || !running || batch.cancelled;
    const apply = ({ record, index }, text, cached) => {
      record.result[index] = text;
      if (cached) record.cachedParts.add(index);
      if (record.parts.every((_, part) => Boolean(record.result[part]))) render(record);
    };
    const matches = result => result?.model === model && (!result.effort || result.effort === effort);
    try {
      const cached = await chrome.runtime.sendMessage({ type: 'LUNA_CACHE', target: language, texts: jobs.map(job => job.text) });
      if (stale()) return;
      if (!cached?.ok || !matches(cached.result) || cached.result.translations?.length !== jobs.length ||
          cached.result.translations.some(item => item !== null && (typeof item?.text !== 'string' || !item.text.trim()))) throw new Error(cached?.error || '无法读取本地译文缓存，请刷新设置后重试。');
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
      const response = await chrome.runtime.sendMessage({ type: 'LUNA_TRANSLATE', requestId: id, priority: rank, target: language, texts: missing.map(job => job.text) });
      if (stale()) return;
      if (!response?.ok) throw new Error(response?.error || '翻译失败。');
      const texts = response.result.translations;
      if (!Array.isArray(texts) || texts.length !== missing.length || !matches(response.result) ||
          texts.some(item => typeof item?.text !== 'string' || !item.text.trim())) throw new Error('翻译结果或模型不匹配。');
      missing.forEach((job, index) => { if (valid(job)) apply(job, texts[index].text, false); });
    } catch (error) {
      if (!stale()) { stop(); errorText = error.message; }
    } finally {
      for (const { record, index } of jobs) if (record.claims.get(index) === id) {
        record.claims.delete(index);
        if (!record.claims.size && record.state !== 'done') record.state = 'pending';
      }
      if (batches.get(id) === batch) batches.delete(id);
      update(); if (running) setTimeout(pump, 50);
    }
  }

  // Independent implementation of site-scoped visual exclusion. Product research
  // and upstream documentation are credited in ACKNOWLEDGEMENTS.md.
  let picker, pickerRoot, pickerText, pickerActions, pickerMarks, picked, choosing = false;
  let candidateSelector = '', pickerSaving = false;

  function refreshExclusions() {
    for (const [element, record] of records) {
      if (!element.isConnected || !eligible(element) || !hasTranslatableContent(element)) {
        removeProgress(record); removeTranslation(record); viewport.unobserve(element); records.delete(element); continue;
      }
      const kept = [], next = parts(sourceText(element, kept));
      if (JSON.stringify(next) !== JSON.stringify(record.parts) || JSON.stringify(kept) !== JSON.stringify(record.kept)) {
        removeProgress(record); removeTranslation(record); record.node = null; record.revision++;
        record.result = []; record.cachedParts.clear(); record.cacheMisses.clear(); record.state = 'pending'; prepareRecord(record);
      }
    }
    if (running) scan(); else update();
  }

  function closePicker() {
    choosing = false; picked = null; candidateSelector = '';
    picker?.remove(); picker = null;
    document.removeEventListener('pointermove', hoverPick, true);
    document.removeEventListener('click', clickPick, true);
    document.removeEventListener('keydown', keyPick, true);
    window.removeEventListener('scroll', repaintPick);
    window.removeEventListener('resize', repaintPick);
  }

  function pickerButton(text, fn, primary = false) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
    if (primary) button.className = 'primary';
    button.addEventListener('click', fn); return button;
  }

  function makePicker() {
    picker = document.createElement('div'); picker.dataset.lunaUi = 'picker';
    pickerRoot = picker.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `:host{all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;color-scheme:light}
      *{box-sizing:border-box}.panel{position:absolute;left:50%;bottom:24px;transform:translateX(-50%);width:min(520px,calc(100vw - 32px));padding:20px 22px;background:#faf7f1;border:1px solid #d9d2c9;border-top:3px solid #b72c26;border-radius:16px;box-shadow:0 12px 42px #14141425;pointer-events:auto;color:#25211e;font:14px/1.65 'PingFang SC',sans-serif}
      strong{display:block;font-size:16px}p{margin:6px 0 14px;color:#6b655d;overflow-wrap:anywhere}.actions{display:flex;flex-wrap:wrap;gap:8px}button{font:inherit;border:1px solid #d9d2c9;border-radius:8px;padding:7px 12px;background:#fffdf9;color:#25211e;cursor:pointer}button.primary{background:#b72c26;color:white;border-color:#b72c26}button:disabled{opacity:.45;cursor:default}button:focus-visible{outline:3px solid #b72c2660;outline-offset:3px}.mark{position:fixed;border:2px solid #b72c26;background:#b72c2610;border-radius:3px;pointer-events:none}`;
    const panel = document.createElement('section'); panel.className = 'panel'; panel.setAttribute('aria-label', '选择不翻译的内容');
    const heading = document.createElement('strong'); heading.textContent = '让这些内容保持原样';
    pickerText = document.createElement('p'); pickerText.setAttribute('role', 'status'); pickerText.setAttribute('aria-live', 'polite');
    pickerActions = document.createElement('div'); pickerActions.className = 'actions';
    pickerMarks = document.createElement('div');
    panel.append(heading, pickerText, pickerActions); pickerRoot.append(style, pickerMarks, panel); document.documentElement.append(picker);
  }

  function startPicker() {
    closePicker(); makePicker(); choosing = true;
    pickerText.textContent = '点选昵称或其他不想翻译的内容。接着预览同类范围；按 Esc 退出。';
    pickerActions.append(pickerButton('取消', closePicker));
    document.addEventListener('pointermove', hoverPick, true);
    document.addEventListener('click', clickPick, true);
    document.addEventListener('keydown', keyPick, true);
    window.addEventListener('scroll', repaintPick, { passive: true });
    window.addEventListener('resize', repaintPick, { passive: true });
    return { picking: true };
  }

  function pickTarget(event) {
    let element = event.target instanceof Element ? event.target : event.target.parentElement;
    if (!element || element.closest('[data-luna-ui]')) return null;
    const translation = element.closest(`[${MARK}]`);
    if (translation) element = [...records.values()].find(record => record.node === translation)?.element;
    if (!element || element === document.body || element === document.documentElement || element.matches('script,style,input,textarea,select')) return null;
    return element;
  }

  function markElements(elements) {
    pickerMarks.replaceChildren();
    for (const element of elements.slice(0, 200)) {
      const box = element.getBoundingClientRect();
      if (box.bottom < 0 || box.top > innerHeight) continue;
      const mark = document.createElement('div'); mark.className = 'mark';
      Object.assign(mark.style, { top: `${box.top}px`, left: `${box.left}px`, width: `${box.width}px`, height: `${box.height}px` });
      pickerMarks.append(mark);
    }
  }

  function hoverPick(event) { if (!picked && choosing) { const element = pickTarget(event); markElements(element ? [element] : []); } }
  function keyPick(event) { if (event.key === 'Escape') { event.preventDefault(); closePicker(); } }
  function matching(selector) {
    try { return [...document.querySelectorAll(selector)].filter(element => !element.closest(`[data-luna-ui],[${MARK}]`)); } catch { return []; }
  }

  function stablePart(element) {
    const tag = element.tagName.toLowerCase();
    for (const attr of ['data-testid', 'data-role', 'itemprop', 'role']) {
      const value = element.getAttribute(attr);
      if (value && /^[a-zA-Z][\w-]{1,60}$/.test(value)) return `${tag}[${attr}="${value}"]`;
    }
    const classes = [...element.classList].filter(value => /^[a-zA-Z][a-zA-Z_-]{2,40}$/.test(value) && !/^(css-|jsx-|sc-|active$|selected$)/i.test(value));
    return classes.length ? `${tag}.${classes.slice(0, 2).join('.')}` : '';
  }

  function proposeSelector(element) {
    const candidates = [], own = stablePart(element);
    if (own) candidates.push(own);
    let path = own || element.tagName.toLowerCase();
    for (let parent = element.parentElement, depth = 0; parent && parent !== document.body && depth < 4; parent = parent.parentElement, depth++) {
      const stable = stablePart(parent) || (parent.matches('article,li') ? parent.tagName.toLowerCase() : '');
      if (stable) candidates.unshift(`${stable} > ${path}`);
      path = `${parent.tagName.toLowerCase()} > ${path}`;
    }
    const checked = candidates.filter(selector => {
      if (selector.length > 300) return false;
      const nodes = matching(selector);
      return nodes.includes(element) && nodes.length > 0 && nodes.length <= 200 &&
        nodes.every(node => !node.matches('html,body,main') && !node.querySelector('main,article'));
    });
    return checked.find(selector => matching(selector).length > 1) || checked[0] || '';
  }

  function repaintPick() {
    if (!picker || !picked) return;
    markElements(candidateSelector ? matching(candidateSelector) : [picked]);
  }

  function selectPick(element) {
    picked = element; candidateSelector = proposeSelector(element);
    const count = candidateSelector ? matching(candidateSelector).length : 1;
    pickerText.textContent = candidateSelector
      ? `高亮了当前页面 ${count} 处同类位置。保存后对 ${location.hostname} 生效，滚动新增的同类内容也保持原样。正文中的选中片段保留，周围句子继续翻译。`
      : '没有找到足够稳定的同类规则。可以只忽略这一处，或扩大选区后重新预览。';
    const save = pickerButton(`不翻译同类 · ${count} 处`, async () => {
      if (pickerSaving || !candidateSelector) return;
      const selector = candidateSelector; pickerSaving = true; save.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ type: 'LUNA_RULE_SAVE', selector });
        if (!response?.ok) throw Error(response?.error || '保存失败。');
        const rule = response.result;
        if (!siteRules.some(item => item.id === rule.id)) siteRules.push(rule);
        closePicker(); refreshExclusions();
        if (rule.created === false) { makePicker(); pickerText.textContent = '此网站已有这条规则。可在设置中管理。'; pickerActions.append(pickerButton('完成', closePicker)); return; }
        showUndo('已记住此网站的排除规则。', async () => {
          const result = await chrome.runtime.sendMessage({ type: 'LUNA_RULE_DELETE', id: rule.id });
          if (!result?.ok) throw Error(result?.error || '撤销失败。');
          siteRules = siteRules.filter(item => item.id !== rule.id);
        });
      } catch (error) { if (picker) pickerText.textContent = error.message; }
      finally { pickerSaving = false; save.disabled = false; }
    }, true);
    save.disabled = !candidateSelector;
    const single = pickerButton('只忽略这一处', () => {
      const node = picked; ignoredNodes.add(node); closePicker(); refreshExclusions();
      showUndo('此处已忽略，仅对当前页面有效。', async () => ignoredNodes.delete(node));
    });
    const parent = pickerButton('扩大选区', () => selectPick(picked.parentElement));
    parent.disabled = !picked.parentElement || picked.parentElement === document.body || picked.parentElement === document.documentElement;
    pickerActions.replaceChildren(save, single, parent, pickerButton('重选', startPicker), pickerButton('取消', closePicker));
    repaintPick();
  }

  function clickPick(event) {
    if (!choosing || event.composedPath().includes(picker)) return;
    const element = pickTarget(event); if (!element) return;
    event.preventDefault(); event.stopImmediatePropagation(); selectPick(element);
  }

  function showUndo(message, undo) {
    makePicker(); pickerText.textContent = message;
    pickerActions.append(pickerButton('撤销', async event => {
      event.currentTarget.disabled = true;
      try { await undo(); closePicker(); refreshExclusions(); }
      catch (error) { pickerText.textContent = error.message; event.currentTarget.disabled = false; }
    }, true), pickerButton('完成', closePicker));
  }

  function start(language = target, restoreOnly = false) {
    checkPage();
    if (language !== target) { reset(); target = language; }
    for (const [id, batch] of batches) cancelBatch(id, batch);
    epoch++;
    cacheOnly = restoreOnly; remembered = restoreOnly; activePage = pageIdentity();
    for (const record of records.values()) { record.cacheMisses.clear(); if (record.state !== 'done') record.state = 'pending'; }
    preparing = false; running = true; errorText = ''; makeBadge();
    for (const record of records.values()) { if (record.node) record.node.hidden = false; viewport.observe(record.element); }
    scan(); update(); return status();
  }

  function stop() {
    for (const [id, batch] of batches) cancelBatch(id, batch);
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
    lastPage = page; ignoredNodes.clear(); closePicker(); reset(); restoreFromHistory(); return true;
  }

  async function restoreFromHistory() {
    const mine = epoch, page = pageIdentity(), revision = restoreRevision;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'LUNA_RESTORE_CONFIG' });
      if (mine === epoch && revision === restoreRevision && !running && !preparing && page === pageIdentity() && response?.ok && response.result.restore) { applyScheduler(response.result); start(response.result.target, true); }
    } catch { /* A new page stays idle when local history is unavailable. */ }
  }

  function ownNode(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return element?.closest(`[${MARK}],[data-luna-ui]`);
  }

  function queueScan(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!element || ownNode(element)) return;
    let root = (ON_X && element.closest(X_ATOMIC)) ||
      (element.matches(CANDIDATES) || element.querySelector(CANDIDATES) ? element : element.closest(CANDIDATES) || element);
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
    attributeFilter: ['open', 'hidden', 'class', 'style', 'aria-expanded', 'aria-hidden', 'data-testid', 'role'],
  });
  document.addEventListener('toggle', event => {
    if (running && event.target.tagName === 'DETAILS') queueScan(event.target);
  }, true);

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type !== 'LUNA_PAGE') return;
    const action = message.action;
    applyScheduler(message);
    const result = action === 'start' ? start(message.target) : action === 'pause' ? stop() :
      action === 'pick' ? startPicker() : action === 'reset' ? reset() : action === 'toggle' ? ((running && !cacheOnly) || preparing ? stop() : start(message.target)) : status();
    respond(result);
  });
  // Only previously translated pages may scan for cache-only restoration.
  // New pages mount the control; neither path starts inference automatically.
  makeBadge(); update();
  chrome.runtime.sendMessage({ type: 'LUNA_UI_CONFIG' }).then(response => { if (response?.ok) applyUI(response.result); }).catch(() => {});
  window.addEventListener('resize', positionButton, { passive: true });
  window.addEventListener('scroll', () => { if (running) pump(); }, { passive: true });
  window.addEventListener('popstate', checkPage);
  window.addEventListener('hashchange', checkPage);
  window.navigation?.addEventListener('currententrychange', checkPage);
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.siteRules) { siteRules = changes.siteRules.newValue?.[location.hostname] || []; refreshExclusions(); }
    if (changes.schedulerConfig) { applyScheduler(changes.schedulerConfig.newValue); pump(); }
    if (changes.settings) applyUI(changes.settings.newValue);
    if (changes.bridgeRevision) { restoreRevision++; reset(); return; }
    if (!changes.settings || (changes.settings.oldValue?.target === changes.settings.newValue?.target &&
        changes.settings.oldValue?.autoRestore === changes.settings.newValue?.autoRestore)) return;
    restoreRevision++;
    if (cacheOnly) reset();
    if (!running && !preparing) restoreFromHistory();
  });
  chrome.runtime.sendMessage({ type: 'LUNA_RULES' }).then(response => { if (response?.ok) siteRules = response.result.rules || []; }).catch(() => {}).finally(() => { rulesLoaded = true; refreshExclusions(); });
  restoreFromHistory();
})();
