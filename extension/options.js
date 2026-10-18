const $ = id => document.getElementById(id);
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '操作失败。');
  return response.result;
}
const notify = text => { $('notice').textContent = text; };
const bytes = value => value < 1048576 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1048576).toFixed(1)} MiB`;
let serviceConfig, concurrencyDirty = false;
let promptDirty = false, cacheDirty = false, modelDirty = false, modelSaving = false, serviceAvailable = false;
let modelCatalog = [];
let viewRevision = 0, connectionCheck = 0, catalogError = '';
const effortNames = { none: '不额外推理', minimal: '最少', low: '低', medium: '中等', high: '高', xhigh: '很高', max: '最高' };
function serviceControls(enabled) {
  serviceAvailable = enabled;
  document.querySelectorAll('.service-control').forEach(control => { control.disabled = !enabled; });
  modelControls();
}
function option(value, label) {
  const node = document.createElement('option'); node.value = value; node.textContent = label; return node;
}
function modelControls() {
  const selected = modelCatalog.find(item => item.model === $('model').value);
  $('model').disabled = !serviceAvailable || !modelCatalog.length;
  $('effort').disabled = !serviceAvailable || !selected;
  $('save-model').disabled = !serviceAvailable || modelSaving || !selected?.efforts.includes($('effort').value);
}
function fillEfforts(model, preferred, allowFallback = false) {
  const selected = modelCatalog.find(item => item.model === model);
  const efforts = selected?.efforts || [];
  const choices = efforts.map(value => option(value, `${value} · ${effortNames[value] || value}`));
  if (preferred && !efforts.includes(preferred) && !allowFallback) choices.push(option(preferred, `${preferred} · 当前不可用`));
  $('effort').replaceChildren(...choices);
  $('effort').value = !allowFallback && preferred ? preferred : efforts.includes(preferred) ? preferred : efforts.includes('medium') ? 'medium' : selected?.defaultEffort || efforts[0] || '';
  $('model-help').textContent = catalogError || (!selected || !efforts.includes($('effort').value)
    ? '已保存的模型或推理强度当前不可用，请重新选择后保存。'
    : '列表来自本机 Codex。保存后使用独立缓存；切回原配置可复用原译文。');
  modelControls();
}
function fillModels(config) {
  const model = modelDirty ? $('model').value : config.model;
  const effort = modelDirty ? $('effort').value : config.effort;
  const choices = modelCatalog.map(item => option(item.model, item.name));
  if (model && !modelCatalog.some(item => item.model === model)) choices.push(option(model, `${model} · 当前不可用`));
  $('model').replaceChildren(...choices); $('model').value = model || '';
  fillEfforts(model, effort);
}
function fillService(config) {
  serviceConfig = config;
  if (!concurrencyDirty) $('concurrency').value = config.concurrency || 12;
  if (!promptDirty) $('supplementalPrompt').value = config.supplementalPrompt;
  if (!cacheDirty) { $('cacheDays').value = config.cacheDays; $('cacheMaxBytes').value = config.cacheMaxBytes; }
  $('base-prompt').textContent = config.basePrompt;
  fillModels(config);
  serviceControls(true);
}
function cacheStats(state) {
  $('cache-size').textContent = `约 ${bytes(state.cacheBytes)}`;
  $('cache-count').textContent = `${state.cacheEntries.toLocaleString()} / ${(state.cacheMaxEntries || 10000).toLocaleString()} 个片段`;
  $('cache-limit').textContent = `上限 ${bytes(state.cacheMaxBytes)} · 保留 ${state.cacheDays} 天`;
  $('cache-progress').value = state.cacheBytes / state.cacheMaxBytes;
}
async function checkConnection() {
  const check = ++connectionCheck, revision = viewRevision;
  $('test').disabled = true;
  try {
    const [state, config, catalog] = await Promise.all([send({ type: 'LUNA_STATUS' }), send({ type: 'LUNA_SERVICE_SETTINGS' }),
      send({ type: 'LUNA_MODELS' }).catch(error => ({ models: [], error: error.message }))]);
    if (check !== connectionCheck || revision !== viewRevision) return;
    modelCatalog = catalog.models;
    catalogError = catalog.error || '';
    fillService(config); cacheStats(state);
    const connected = state.authentication === 'chatgpt';
    $('dot').className = `dot ${connected ? 'online' : 'error'}`;
    $('connection').textContent = connected ? '已连接 · ChatGPT 订阅' : '本机服务已连接 · 需要 Codex 登录';
    $('account-detail').textContent = connected ? `${state.model} · ${state.effort} · 与本机 Codex 共用订阅额度。` : state.message || '展开下方连接指南，完成 ChatGPT 登录后重新检测。';
  } catch (error) {
    if (check !== connectionCheck || revision !== viewRevision) return;
    $('dot').className = 'dot error'; $('connection').textContent = '本机服务未连接';
    $('account-detail').textContent = error.message; serviceControls(false);
  } finally { if (check === connectionCheck) $('test').disabled = false; }
}
async function saveLocal(settings, message) {
  await send({ type: 'LUNA_SAVE', settings }); viewRevision++; notify(message);
}
async function operation(button, fn) {
  button.disabled = true;
  try { await fn(); } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
}
serviceControls(false);
$('supplementalPrompt').addEventListener('input', () => { promptDirty = true; });
for (const key of ['cacheDays', 'cacheMaxBytes']) $(key).addEventListener('change', () => { cacheDirty = true; });
$('model').addEventListener('change', () => { modelDirty = true; fillEfforts($('model').value, $('effort').value, true); });
$('effort').addEventListener('change', () => { modelDirty = true; modelControls(); });
$('save-model').addEventListener('click', event => {
  modelSaving = true;
  return operation(event.currentTarget, async () => {
    const submitted = { model: $('model').value, effort: $('effort').value };
    const config = await send({ type: 'LUNA_SERVICE_SAVE', settings: submitted });
    viewRevision++;
    if ($('model').value === submitted.model && $('effort').value === submitted.effort) modelDirty = false;
    fillService(config); notify('模型与推理强度已保存。下次点击翻译使用此配置及其独立缓存。');
    $('account-detail').textContent = `${config.model} · ${config.effort} · 与本机 Codex 共用订阅额度。`;
  }).finally(() => { modelSaving = false; modelControls(); });
});
(async () => {
  try {
    const config = await send({ type: 'LUNA_SETTINGS' });
    for (const key of ['endpoint', 'token', 'target', 'side']) $(key).value = config[key];
    for (const key of ['autoRestore', 'showLauncher', 'autoHide']) $(key).checked = config[key];
  } catch (error) { notify(error.message); }
  await checkConnection();
})();
$('save-reading').addEventListener('click', event => operation(event.currentTarget, () => saveLocal({ target: $('target').value, autoRestore: $('autoRestore').checked }, '阅读偏好已保存。语言在下一轮翻译时采用。')));
$('save-appearance').addEventListener('click', event => operation(event.currentTarget, () => saveLocal({ side: $('side').value, autoHide: $('autoHide').checked, showLauncher: $('showLauncher').checked }, '按钮偏好已保存，打开的网页会同步更新。')));
$('reset-position').addEventListener('click', event => operation(event.currentTarget, () => saveLocal({ vertical: 0.5, side: $('side').value }, '按钮已恢复到屏幕中部。')));
$('form').addEventListener('submit', event => {
  event.preventDefault(); operation(event.submitter, async () => {
    await saveLocal(Object.fromEntries(['endpoint', 'token'].map(key => [key, $(key).value.trim()])), '本地连接已保存。');
    await checkConnection();
  });
});
$('test').addEventListener('click', checkConnection);
$('save-prompt').addEventListener('click', event => operation(event.currentTarget, async () => {
  const submitted = $('supplementalPrompt').value;
  const config = await send({ type: 'LUNA_SERVICE_SAVE', settings: { supplementalPrompt: submitted } });
  viewRevision++;
  if ($('supplementalPrompt').value === submitted) promptDirty = false;
  fillService(config); notify('翻译说明已保存。下次点击翻译使用新说明及其独立缓存。');
}));
$('default-prompt').addEventListener('click', () => { $('supplementalPrompt').value = ''; promptDirty = true; notify('已填回默认规则；点击“保存翻译说明”后生效。'); });
$('save-cache').addEventListener('click', event => operation(event.currentTarget, async () => {
  const submitted = { cacheDays: Number($('cacheDays').value), cacheMaxBytes: Number($('cacheMaxBytes').value) };
  const config = await send({ type: 'LUNA_SERVICE_SAVE', settings: submitted });
  viewRevision++;
  if (Number($('cacheDays').value) === submitted.cacheDays && Number($('cacheMaxBytes').value) === submitted.cacheMaxBytes) cacheDirty = false;
  serviceConfig = config; cacheStats(await send({ type: 'LUNA_STATUS' })); notify('缓存策略已保存，超出新限制的结果已清理。');
}));
$('clear-cache').addEventListener('click', event => operation(event.currentTarget, async () => {
  // An explicit product control; it affects translations only, never account credentials.
  const result = await send({ type: 'LUNA_CLEAR_CACHE' }); cacheStats(result);
  viewRevision++;
  notify('翻译缓存已清空。登录、连接和偏好保留；本浏览器的页面翻译已重置。');
}));

$('concurrency').addEventListener('input', () => { concurrencyDirty = true; });
$('save-concurrency').addEventListener('click', event => operation(event.currentTarget, async () => {
  const concurrency = Number($('concurrency').value);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 24) throw new Error('并发量请输入 1–24 的整数。');
  const config = await send({ type: 'LUNA_SERVICE_SAVE', settings: { concurrency } });
  viewRevision++;
  if (Number($('concurrency').value) === concurrency) concurrencyDirty = false;
  fillService(config); notify(`并发上限已设为 ${config.concurrency}，本机所有标签页共用；已开始的请求会完成。`);
}));
async function showRules() {
  try {
    const sites = await send({ type: 'LUNA_RULE_LIST' });
    const list = $('site-rules'); list.replaceChildren();
    for (const [host, rules] of Object.entries(sites)) for (const rule of rules) {
      const row = document.createElement('div'); row.className = 'setting-row';
      const text = document.createElement('span'); text.textContent = host;
      const small = document.createElement('small'); small.textContent = rule.selector; text.append(small);
      const remove = document.createElement('button'); remove.className = 'quiet'; remove.textContent = '删除';
      remove.addEventListener('click', () => operation(remove, async () => {
        await send({ type: 'LUNA_RULE_DELETE', host, id: rule.id }); await showRules(); notify('排除规则已删除，打开的页面已更新。');
      }));
      row.append(text, remove); list.append(row);
    }
    if (!list.children.length) list.textContent = '还没有保存的网站排除规则。';
  } catch (error) { $('site-rules').textContent = error.message; }
}
showRules();
