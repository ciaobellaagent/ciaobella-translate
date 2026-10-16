import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexTranslator, validateSubscriptionConfig } from '../bridge/codex.mjs';

test('provider credentials cannot silently change subscription billing to API usage', () => {
  const provider = { name: 'HTTP only', wire_api: 'responses', requires_openai_auth: true, supports_websockets: false };
  const config = value => ({ model_provider: 'openai_http', model_providers: { openai_http: value } });
  assert.equal(validateSubscriptionConfig(config(provider)), 'openai_http');
  for (const extra of [{ env_key: 'SOME_API_KEY' }, { experimental_bearer_token: 'secret' },
    { http_headers: { Authorization: 'Bearer secret' } }, { env_http_headers: { Authorization: 'KEY' } },
    { base_url: 'https://proxy.example/v1' }]) assert.throws(() => validateSubscriptionConfig(config({ ...provider, ...extra })));
});

test('only completed turns succeed; partial streaming output never counts as success', async () => {
  const c = new CodexTranslator();
  let failed;
  c.turns.set('thread', { delta: '', text: '', resolve: () => assert.fail('must not resolve'), reject: e => { failed = e; } });
  c.onMessage({ method: 'item/agentMessage/delta', params: { threadId: 'thread', delta: 'partial' } });
  c.onMessage({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'failed', error: { message: 'usage limit' } } } });
  assert.match(failed.message, /usage limit/);
});

test('unexpected tool calls are rejected and interrupt the turn', async () => {
  const c = new CodexTranslator(); let failed, interrupted;
  c.rpc = async (...args) => { interrupted = args; };
  c.turns.set('thread', { reject: e => { failed = e; } });
  c.onMessage({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: { type: 'commandExecution' } } });
  assert.match(failed.message, /工具/); assert.equal(interrupted[0], 'turn/interrupt');
});
