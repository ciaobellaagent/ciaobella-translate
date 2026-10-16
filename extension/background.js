const DEFAULTS = { endpoint: 'http://127.0.0.1:18472', token: '', target: 'zh-CN', side: 'right', vertical: 0.5,
  autoHide: true, showLauncher: true, autoRestore: true };
const TARGETS = new Set(['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es']);
const CACHE_AGE = 30 * 86400000;
let pageWrites = Promise.resolve();
let preferenceWrites = Promise.resolve();

function extensionPage(sender) {
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('此操作只能由扩展设置页发起。');
}

function uiSettings(config) {
  return Object.fromEntries(['side', 'vertical', 'autoHide', 'showLauncher'].map(key => [key, config[key]]));
}

function savePreferences(patch) {
  const job = preferenceWrites.then(async () => {
    const current = await settings();
    const value = { ...current, ...patch };
    if (!TARGETS.has(value.target)) throw new Error('目标语言无效。');
    const url = new URL(value.endpoint);
    if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash ||
      (value.token !== '' && !/^[a-f0-9]{64}$/.test(value.token))) throw new Error('服务地址或连接码无效。');
    if (!['left', 'right'].includes(value.side) || !Number.isFinite(value.vertical) || value.vertical < 0 || value.vertical > 1 ||
      ['autoHide', 'showLauncher', 'autoRestore'].some(key => typeof value[key] !== 'boolean')) throw new Error('阅读或按钮偏好无效。');
    await chrome.storage.local.set({ settings: { endpoint: url.origin, token: value.token, target: value.target, ...uiSettings(value), autoRestore: value.autoRestore } });
    return { saved: true };
  });
  preferenceWrites = job.catch(() => {});
  return job;
}

async function pageKey(sender) {
  const url = new URL(sender.url);
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_|^(?:gclid|fbclid)$/i.test(key)) url.searchParams.delete(key);
  }
  // Preserve unknown query ordering and hashes: either can identify an SPA route.
  url.search = url.searchParams.toString();
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.href));
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function recentPage(value) {
  return TARGETS.has(value?.target) && Number.isFinite(value.at) && value.at <= Date.now() && Date.now() - value.at < CACHE_AGE;
}

async function rememberPage(sender, target) {
  const key = await pageKey(sender);
  const job = pageWrites.then(async () => {
    const pages = (await chrome.storage.local.get('translatedPages')).translatedPages || {};
    const entries = Object.entries(pages).filter(([id, value]) => /^[a-f0-9]{64}$/.test(id) && id !== key && recentPage(value));
    entries.push([key, { target, at: Date.now() }]);
    await chrome.storage.local.set({ translatedPages: Object.fromEntries(entries.slice(-2000)) });
    return { remembered: true };
  });
  pageWrites = job.catch(() => {});
  return job;
}

async function settings() {
  let paired = {};
  try { paired = await (await fetch(chrome.runtime.getURL('connection.json'))).json(); } catch { /* portable package */ }
  return { ...DEFAULTS, ...paired, ...(await chrome.storage.local.get('settings')).settings };
}

async function request(path, body, timeout = 10000) {
  const config = await settings();
  if (!config.token) throw new Error('请在设置中填写本地连接码，或加载本地服务生成的已配对扩展。');
  const url = new URL(config.endpoint);
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:' || url.pathname !== '/') throw new Error('服务地址必须是 http://127.0.0.1:端口。');
  const response = await fetch(`${url.origin}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'Authorization': `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout),
  }).catch(error => { throw new Error(error.name === 'TimeoutError' ? '本地服务响应超时，请检查服务是否运行。' : '连接不到本地翻译服务，请先启动 Luna 翻译。'); });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `翻译服务返回 ${response.status}`);
  return result;
}

async function translate(texts, target) {
  const job = await request('/jobs', { text_list: texts, target_lang: target, source_lang: 'auto' });
  const until = Date.now() + 180000;
  while (Date.now() < until) {
    // A short fetch plus an extension API call keeps the worker alive while queued.
    await chrome.storage.local.get('settings');
    const status = await request(`/jobs/${job.id}`);
    if (status.state === 'failed') throw new Error(status.error);
    if (status.state === 'completed') return status.result;
    await new Promise(resolve => setTimeout(resolve, 650));
  }
  throw new Error('翻译等待超时，已暂停；请稍后重试。');
}

async function tabAction(tabId, action) {
  if (!tabId) throw new Error('没有可操作的网页。');
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  const config = await settings();
  return chrome.tabs.sendMessage(tabId, { type: 'LUNA_PAGE', action, target: config.target });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message?.type?.startsWith('LUNA_')) return;
  (async () => {
    switch (message.type) {
      case 'LUNA_TRANSLATE':
        if (!sender.tab || !/^https?:/.test(sender.url || '')) throw new Error('只接受网页翻译请求。');
        if (!TARGETS.has(message.target)) throw new Error('目标语言无效，请刷新网页后重试。');
        return translate(message.texts, message.target);
      case 'LUNA_CACHE':
        if (!sender.tab || !/^https?:/.test(sender.url || '') || !TARGETS.has(message.target)) throw new Error('缓存请求无效。');
        return request('/cache', { text_list: message.texts, target_lang: message.target, source_lang: 'auto' });
      case 'LUNA_RESTORE_CONFIG': {
        if (!sender.tab || !/^https?:/.test(sender.url || '') || (sender.frameId && sender.frameId !== 0)) throw new Error('页面请求无效。');
        const key = await pageKey(sender);
        await pageWrites;
        const { target, autoRestore } = await settings();
        const page = (await chrome.storage.local.get('translatedPages')).translatedPages?.[key];
        return { target, restore: autoRestore && recentPage(page) && page.target === target };
      }
      case 'LUNA_REMEMBER':
        if (!sender.tab || !/^https?:/.test(sender.url || '') || !TARGETS.has(message.target) || (sender.frameId && sender.frameId !== 0)) throw new Error('页面记录无效。');
        return rememberPage(sender, message.target);
      case 'LUNA_PAGE_CONFIG':
        if (!sender.tab || !/^https?:/.test(sender.url || '')) throw new Error('只接受网页设置请求。');
        return { target: (await settings()).target };
      case 'LUNA_UI_CONFIG':
        if (!sender.tab || !/^https?:/.test(sender.url || '')) throw new Error('页面请求无效。');
        return uiSettings(await settings());
      case 'LUNA_FLOAT_SAVE':
        if (!sender.tab || !/^https?:/.test(sender.url || '') || !['left', 'right'].includes(message.side) ||
          !Number.isFinite(message.vertical) || message.vertical < 0 || message.vertical > 1) throw new Error('按钮位置无效。');
        return savePreferences({ side: message.side, vertical: message.vertical });
      case 'LUNA_OPEN_SETTINGS':
        if (!sender.tab || !/^https?:/.test(sender.url || '')) throw new Error('页面请求无效。');
        await chrome.runtime.openOptionsPage(); return { opened: true };
      case 'LUNA_STATUS': return request('/status');
      case 'LUNA_SETTINGS': extensionPage(sender); return settings();
      case 'LUNA_SERVICE_SETTINGS': extensionPage(sender); return request('/settings');
      case 'LUNA_MODELS': extensionPage(sender); return request('/models');
      case 'LUNA_SERVICE_SAVE': {
        extensionPage(sender);
        const before = await request('/settings');
        const result = await request('/settings', message.settings);
        if (before.promptRevision !== result.promptRevision) await chrome.storage.local.set({ bridgeRevision: Date.now() });
        return result;
      }
      case 'LUNA_CLEAR_CACHE': {
        extensionPage(sender);
        const result = await request('/cache/clear', {});
        const job = pageWrites.then(() => chrome.storage.local.set({ translatedPages: {}, bridgeRevision: Date.now() }));
        pageWrites = job.catch(() => {}); await job;
        return result;
      }
      case 'LUNA_SAVE': {
        if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('设置只能由扩展页面修改。');
        const patch = message.settings;
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !Object.hasOwn(DEFAULTS, key))) throw new Error('设置字段无效。');
        if ('token' in patch && !/^[a-f0-9]{64}$/.test(patch.token)) throw new Error('本地连接码无效。');
        // Merge the user's patch only after prior writes finish. An unpaired
        // install may still save language and appearance without credentials.
        return savePreferences(patch);
      }
      case 'LUNA_TAB':
        if (!sender.url?.startsWith(chrome.runtime.getURL(''))) throw new Error('需要扩展页面。');
        return tabAction(message.tabId, message.action);
      default: throw new Error('未知操作。');
    }
  })().then(result => respond({ ok: true, result }), error => respond({ ok: false, error: error.message }));
  return true;
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-translation') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { await tabAction(tab?.id, 'toggle'); } catch { /* protected Chrome pages cannot be injected */ }
});
