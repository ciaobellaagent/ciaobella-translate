import { mkdir, readFile, writeFile, chmod, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareRuntime, RUNTIME, PORT } from '../bridge/server.mjs';
import { findCodex } from '../bridge/codex.mjs';
import { SettingsStore } from '../bridge/settings.mjs';

const exec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LABEL = 'com.workbench.luna-translate';
const target = `gui/${process.getuid()}/${LABEL}`;
const escapeXml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

async function liveJob() {
  try { return (await exec('/bin/launchctl', ['print', target])).stdout; } catch { return null; }
}

async function listenerPids(port) {
  try {
    const { stdout } = await exec('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    const values = [...new Set(stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
    if (values.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw new Error('listener PID 无效。');
    return values;
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return [];
    throw new Error('无法核验端口占用，未安装或发送连接码。');
  }
}

const jobPid = job => Number(job?.match(/^\s*pid = (\d+)/m)?.[1]) || null;

export function assertPortOwnership(pids, pid, allowEmpty = false) {
  if (pids.length === 0 && allowEmpty) return false;
  if (!pid || pids.length !== 1 || pids[0] !== pid) throw new Error('本地端口归属不符，未替换服务或发送连接码。');
  return true;
}

export async function serviceStatus({ token, port, pid, listeners = listenerPids, request = fetch }) {
  // Never send the pairing credential until the live listener matches launchd.
  if (!assertPortOwnership(await listeners(port), pid, true)) return null;
  const response = await request(`http://127.0.0.1:${port}/status`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2500),
  });
  return response.ok ? response.json() : null;
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('后台服务安装器目前只支持 macOS。');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('需要 Node.js 22 或更新版本。');
  if (PORT !== 18472) throw new Error('安装后台服务时使用固定端口 18472，请移除 LUNA_TRANSLATE_PORT。');
  const node = await realpath(process.execPath);
  const codex = await findCodex();
  const agents = join(homedir(), 'Library/LaunchAgents');
  const plistPath = join(agents, `${LABEL}.plist`);
  const stdout = join(RUNTIME, 'service.stdout.log');
  const stderr = join(RUNTIME, 'service.stderr.log');
  const environment = {
    HOME: homedir(), PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LUNA_TRANSLATE_RUNTIME: RUNTIME, LUNA_CODEX_BIN: codex,
  };
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${escapeXml(node)}</string><string>${escapeXml(join(ROOT, 'bridge/server.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${escapeXml(ROOT)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${escapeXml(stdout)}</string>
<key>StandardErrorPath</key><string>${escapeXml(stderr)}</string>
</dict></plist>
`;
  let existing;
  try { existing = await readFile(plistPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && existing !== plist) throw new Error('现有同名服务配置与本项目不同，未覆盖。请先核对其归属。');
  const loaded = await liveJob();
  if (loaded && !existing) throw new Error('同名 launchd job 已存在，但没有本项目配置，未接管。');
  if (loaded && !loaded.includes(`path = ${plistPath}\n`)) throw new Error('已加载服务的配置来源不同，未接管。');
  assertPortOwnership(await listenerPids(PORT), jobPid(loaded), true);
  const { token, extension } = await prepareRuntime();
  for (const path of [stdout, stderr]) {
    await writeFile(path, '', { flag: 'a', mode: 0o600 }); await chmod(path, 0o600);
  }
  await mkdir(agents, { recursive: true, mode: 0o700 });
  if (!existing) await writeFile(plistPath, plist, { flag: 'wx', mode: 0o600 });
  await exec('/usr/bin/plutil', ['-lint', plistPath]);
  if (!loaded) await exec('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath]);
  let status;
  for (let i = 0; i < 40; i++) {
    const pid = jobPid(await liveJob());
    // Ownership failures stop immediately; they are never treated as startup latency.
    const pids = await listenerPids(PORT);
    const owned = assertPortOwnership(pids, pid, true);
    try {
      if (owned) status = await serviceStatus({ token, port: PORT, pid });
      if (status) break;
    } catch { /* wait for first startup */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  const expected = await new SettingsStore({ runtime: RUNTIME }).load();
  if (status?.model !== expected.model || status?.effort !== expected.effort || !['chatgpt', 'required'].includes(status.authentication)) throw new Error('服务尚未通过连接验证；配置已保留，请检查本地日志。');
  const job = await liveJob();
  const pid = jobPid(job);
  assertPortOwnership(await listenerPids(PORT), pid);
  const receipt = {
    installedAt: new Date().toISOString(), label: LABEL, pid, port: PORT,
    model: status.model, authentication: status.authentication, provider: status.provider,
    plist: plistPath, extension, loginStartup: true, inferenceTriggered: false,
  };
  await writeFile(join(RUNTIME, 'service-installation.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
