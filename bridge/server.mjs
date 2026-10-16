import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, cp } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CodexTranslator, VERSION, assertModelChoice } from './codex.mjs';
import { TranslationService, HttpError, validateInput } from './translate.mjs';
import { SettingsStore } from './settings.mjs';

export const RUNTIME = process.env.LUNA_TRANSLATE_RUNTIME || join(homedir(), '.local/state/workbench/luna-translate');
export const PORT = Number(process.env.LUNA_TRANSLATE_PORT || 18472);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function matches(a, b) {
  const aa = Buffer.from(a || ''), bb = Buffer.from(b || '');
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export function createServer({ service, token, translator, settings = new SettingsStore(), port = PORT }) {
  const jobs = new Map();
  const cacheStatus = () => ({ cacheEntries: service.cache.size, cacheDays: service.ttl / 86400000,
    cacheBytes: service.cacheBytes, cacheMaxBytes: service.maxBytes, cacheMaxEntries: service.maxCache });
  return http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", ...cors });
      res.end(JSON.stringify(body));
    };
    let cors = {};
    try {
      const listenerPort = port || req.socket.localPort;
      if (![ `127.0.0.1:${listenerPort}`, `localhost:${listenerPort}` ].includes(req.headers.host)) throw new HttpError(403, 'Host 不允许。');
      const origin = req.headers.origin;
      if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) throw new HttpError(403, '仅允许浏览器扩展访问。');
      if (origin) cors = { 'Access-Control-Allow-Origin': origin, 'Vary': 'Origin',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
      if (req.method === 'OPTIONS') { reply(204, {}); return; }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === 'GET' && url.pathname === '/health') {
        reply(200, { service: 'luna-immersive-translate', version: VERSION, model: service.model, effort: service.effort }); return;
      }
      if (req.method === 'GET' && url.pathname === '/demo') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
        res.end(await readFile(join(ROOT, 'fixtures/reading.html'), 'utf8')); return;
      }
      const authorization = req.headers.authorization?.replace(/^Bearer /i, '') || url.searchParams.get('key');
      if (!matches(authorization, token)) throw new HttpError(401, '本地连接码无效，请检查插件设置。');
      if (req.method === 'GET' && url.pathname === '/settings') {
        reply(200, settings.read()); return;
      }
      if (req.method === 'GET' && url.pathname === '/models') {
        reply(200, { models: await translator.models({ refresh: true }) }); return;
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        const connection = await (translator.status ? translator.status() : translator.start());
        reply(200, { ...connection, model: service.model, effort: service.effort, pending: service.pending, requests: service.requests,
          accountConnected: connection.accountConnected ?? connection.authentication === 'chatgpt',
          cacheHits: service.cacheHits, ...cacheStatus(), promptRevision: settings.read().promptRevision,
          lastUsage: translator.lastUsage }); return;
      }
      if (req.method === 'GET' && /^\/jobs\/[a-f0-9]{32}$/.test(url.pathname)) {
        const job = jobs.get(url.pathname.split('/').pop());
        if (!job) throw new HttpError(404, '翻译任务已过期，请重试。');
        reply(200, job); return;
      }
      if (req.method !== 'POST' || !['/translate', '/jobs', '/cache', '/settings', '/cache/clear'].includes(url.pathname)) throw new HttpError(404, '接口不存在。');
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, '需要 application/json。');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 256000) throw new HttpError(413, '请求过大。');
      }
      let body;
      try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'JSON 格式无效。'); }
      if (url.pathname === '/settings') {
        const updated = await settings.update(body, { validate: async next => {
          if ('model' in body || 'effort' in body) assertModelChoice(await translator.models(), next.model, next.effort);
        } });
        service.setSettings(updated);
        await service.flush();
        reply(200, updated); return;
      }
      if (url.pathname === '/cache/clear') {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new HttpError(400, '清理缓存请提交空 JSON 对象。');
        await service.clearCache();
        reply(200, { cleared: true, ...cacheStatus() }); return;
      }
      validateInput(body, service);
      if (url.pathname === '/cache') { reply(200, service.lookup(body)); return; }
      if (url.pathname === '/jobs') {
        for (const [id, job] of jobs) if (Date.now() - job.at > 600000) jobs.delete(id);
        if (jobs.size >= 100 || service.pending >= 16) throw new HttpError(429, '翻译队列已满，请稍后重试。');
        const id = randomBytes(16).toString('hex');
        const job = { state: 'pending', at: Date.now() }; jobs.set(id, job);
        service.translate(body).then(result => Object.assign(job, { state: 'completed', result }),
          error => Object.assign(job, { state: 'failed', error: error.message }));
        reply(202, { id }); return;
      }
      reply(200, await service.translate(body));
    } catch (error) {
      const status = error.status || (/quota|rate.?limit|usage.?limit|credits|额度/i.test(error.message) ? 429 : 502);
      reply(status, { error: error.message, model: service.model, effort: service.effort, fallback: false });
    }
  });
}

export async function prepareRuntime(runtime = RUNTIME, port = PORT) {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700);
  const tokenPath = join(runtime, 'connection-token');
  let token;
  try { token = (await readFile(tokenPath, 'utf8')).trim(); } catch { /* first run */ }
  if (!/^[a-f0-9]{64}$/.test(token || '')) {
    token = randomBytes(32).toString('hex');
    await writeFile(tokenPath, token, { mode: 0o600 });
  }
  await chmod(tokenPath, 0o600);
  const extension = join(runtime, 'extension');
  await cp(join(ROOT, 'extension'), extension, { recursive: true });
  await writeFile(join(extension, 'connection.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, token }), { mode: 0o600 });
  // Protocol reference: https://immersivetranslate.com/en/docs/services/custom/
  // See ACKNOWLEDGEMENTS.md; no original-extension implementation is bundled.
  await writeFile(join(runtime, 'immersive-translate-url.txt'), `http://127.0.0.1:${port}/translate?key=${token}\n`, { mode: 0o600 });
  return { token, extension };
}

export async function main() {
  const translator = new CodexTranslator({ runtime: RUNTIME });
  const service = new TranslationService(translator, { runtime: RUNTIME });
  const settings = new SettingsStore({ runtime: RUNTIME });
  // Bind before generating credentials/runtime projections: don't overwrite a running instance.
  const server = http.createServer((req, res) => { res.writeHead(503); res.end('Starting'); });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用；请检查原翻译服务。` : error.message); process.exitCode = 1; });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  try {
    const { token, extension } = await prepareRuntime();
    service.setSettings(await settings.load());
    await service.load();
    // Keep the listener and replace its handler with the authenticated handler.
    server.removeAllListeners('request');
    const handler = createServer({ service, translator, settings, token, port: PORT }).listeners('request')[0];
    server.on('request', handler);
    const connection = await translator.start();
    console.log(`Ciao Bella Translate 已启动：127.0.0.1:${PORT} · ${service.model} / ${service.effort} · ${connection.accountConnected ? 'ChatGPT 订阅' : '等待 codex login 登录'}`);
    console.log(`Chrome「加载已解压的扩展程序」目录：${extension}`);
    console.log(`原版沉浸式翻译 Custom API 地址文件：${join(RUNTIME, 'immersive-translate-url.txt')}`);
    const stop = () => {
      translator.close(); server.closeAllConnections(); server.close();
      service.flush().catch(() => console.error('未能保存最近的缓存访问顺序。'));
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { translator.close(); server.close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
