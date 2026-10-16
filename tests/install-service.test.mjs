import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPortOwnership, serviceStatus } from '../scripts/install-local-service.mjs';

test('an unrelated non-HTTP listener never receives the pairing credential', async () => {
  let sent = false;
  await assert.rejects(serviceStatus({ token: 'private', port: 18472, pid: 100,
    listeners: async () => [200], request: async () => { sent = true; throw new Error('not HTTP'); } }), /归属/);
  assert.equal(sent, false);
  assert.throws(() => assertPortOwnership([200], null, true), /归属/);
});

test('startup waits for a listener; only the verified launchd PID can receive status requests', async () => {
  let sent = 0;
  const request = async () => { sent++; return { ok: true, json: async () => ({ model: 'gpt-6-luna' }) }; };
  assert.equal(await serviceStatus({ token: 'private', port: 18472, pid: 100, listeners: async () => [], request }), null);
  assert.equal(sent, 0);
  const status = await serviceStatus({ token: 'private', port: 18472, pid: 100, listeners: async () => [100], request });
  assert.equal(status.model, 'gpt-6-luna'); assert.equal(sent, 1);
});
