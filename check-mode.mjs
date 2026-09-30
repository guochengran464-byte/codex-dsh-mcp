import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { apply } from './dsh-plugin.mjs';

const stateDir = await mkdtemp(join(tmpdir(), 'dsh-mode-check-'));
const token = 'local-check-token-with-at-least-32-characters';
await writeFile(join(stateDir, 'token'), token);
const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const deliveries = [];
const disposers = [];
const sessionId = 'codex-mcp-00000000-0000-0000-0000-000000000000';
let selectedProvider = 'test-provider';
const queriedProviders = [];
const ctx = {
  on() {}, effect(setup) { disposers.push(setup()); },
  logger: { info() {}, warn() {} }, agents: { get() {} },
  workspaceRegistry: { archivedSessionIds: [] },
  agentDefaultModel: { currentSelection: () => ({ provider: selectedProvider, model: 'test-model' }) },
  llm: {
    listProviders: () => [{ id: 'test-provider' }, { id: 'blocked-provider' }],
    async listModels(provider) { queriedProviders.push(provider); return [{ id: 'test-model' }]; },
    async resolveModelInfo() { return {}; },
  },
  sessionQuery: { async readSession() { return { session: { cwd: stateDir },
    events: [{ seq: 0, type: 'model/selection', data: { provider: selectedProvider } }] }; } },
  sessionController: { async prompt(request) { deliveries.push(request.mode); } },
};
async function rpc(method, args = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
    signal: AbortSignal.timeout(5000),
  });
  return response.json();
}
const chat = mode => rpc('chat', { session_id: sessionId, prompt: 'check', mode });
try {
  await assert.rejects(apply(ctx, { stateDir, port }), /Configure allowedProviders/);
  await apply(ctx, { stateDir, port, allowedProviders: ['test-provider'] });
  const info = await rpc('info');
  assert.equal(info.ok, true);
  assert.deepEqual(info.value.models.routableProviders, ['test-provider']);
  assert.deepEqual(queriedProviders, ['test-provider']);
  for (const [input, expected] of [[undefined, 'queue'], ['queue', 'queue'], ['steer', 'steer']]) {
    const result = await chat(input);
    assert.equal(result.ok, true);
    assert.equal(result.value.mode, expected);
    assert.equal(deliveries.at(-1), expected);
  }
  const invalid = await chat('invalid');
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /mode must be queue or steer/);
  selectedProvider = 'blocked-provider';
  const blocked = await chat('queue');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Provider is not allowed/);
  assert.deepEqual(deliveries, ['queue', 'queue', 'steer']);
  console.log('Check passed: provider allowlist, default queue, queue, steer, invalid rejected.');
} finally {
  for (const dispose of disposers.reverse()) await dispose?.();
  assert.equal(dirname(resolve(stateDir)), resolve(tmpdir()));
  await rm(stateDir, { recursive: true, force: true });
}
