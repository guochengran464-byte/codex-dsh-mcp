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
const ctx = {
  on() {}, effect(setup) { disposers.push(setup()); },
  logger: { info() {}, warn() {} }, agents: { get() {} },
  workspaceRegistry: { archivedSessionIds: [] },
  sessionQuery: { async readSession() { return { session: { cwd: stateDir },
    events: [{ seq: 0, type: 'model/selection', data: { provider: 'dcs-cloud-chat' } }] }; } },
  sessionController: { async prompt(request) { deliveries.push(request.mode); } },
};
async function chat(mode) {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'chat', args: { session_id: sessionId, prompt: 'check', mode } }),
    signal: AbortSignal.timeout(5000),
  });
  return response.json();
}
try {
  await apply(ctx, { stateDir, port });
  for (const [input, expected] of [[undefined, 'queue'], ['queue', 'queue'], ['steer', 'steer']]) {
    const result = await chat(input);
    assert.equal(result.ok, true);
    assert.equal(result.value.mode, expected);
    assert.equal(deliveries.at(-1), expected);
  }
  const invalid = await chat('invalid');
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /mode must be queue or steer/);
  assert.deepEqual(deliveries, ['queue', 'queue', 'steer']);
  console.log('Mode check passed: default queue, queue, steer, invalid rejected.');
} finally {
  for (const dispose of disposers.reverse()) await dispose?.();
  assert.equal(dirname(resolve(stateDir)), resolve(tmpdir()));
  await rm(stateDir, { recursive: true, force: true });
}
