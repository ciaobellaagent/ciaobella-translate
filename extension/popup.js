const $ = id => document.getElementById(id);
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '操作失败。');
  return response.result;
}
async function action(value) {
  $('notice').textContent = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error('请打开普通网页后使用；Chrome 内置页和商店页无法翻译。');
    const state = await send({ type: 'LUNA_TAB', tabId: tab.id, action: value });
    $('notice').textContent = value === 'reset' ? '已恢复原文。' : value === 'pause' ? '已暂停。现有译文保留。' : state.error || '已开启。滚动页面时会继续翻译。';
  } catch (error) { $('notice').textContent = error.message; }
}
$('start').addEventListener('click', () => action('start'));
$('pause').addEventListener('click', () => action('pause'));
$('reset').addEventListener('click', () => action('reset'));
$('settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
(async () => {
  try {
    const state = await send({ type: 'LUNA_STATUS' });
    $('dot').className = 'dot online';
    $('connection').textContent = state.authentication === 'chatgpt' ? '已连接 · ChatGPT 订阅' : '需要订阅登录';
    $('model-status').textContent = `${state.model.replace(/^gpt-/, '')} · ${state.effort || '未提供'}`;
    $('model-status').title = `${state.model} · ${state.effort || '未提供'}`;
  } catch (error) {
    $('dot').className = 'dot error'; $('connection').textContent = '本地服务未连接';
    $('notice').textContent = error.message;
  }
})();
