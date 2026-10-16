import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const folder of ['bridge', 'extension', 'scripts', 'tests']) {
  for (const name of readdirSync(join(root, folder))) if (/\.(mjs|js)$/.test(name)) execFileSync(process.execPath, ['--check', join(root, folder, name)]);
}
const manifest = JSON.parse(readFileSync(join(root, 'extension/manifest.json')));
if (manifest.manifest_version !== 3 || manifest.permissions.some(p => !['activeTab', 'scripting', 'storage'].includes(p))) throw new Error('Unexpected extension permissions');
const expectedScripts = [{ matches: ['http://*/*', 'https://*/*'], js: ['content.js'], run_at: 'document_idle' }];
if (JSON.stringify(manifest.content_scripts) !== JSON.stringify(expectedScripts) ||
    JSON.stringify(manifest.host_permissions) !== JSON.stringify(['http://127.0.0.1/*'])) throw new Error('Unexpected automatic UI scope or network permission');
if (JSON.parse(readFileSync(join(root, 'extension/connection.json'))).token !== '') throw new Error('Do not ship a paired connection token');
console.log('Syntax, manifest permissions, and token-free package: OK');
