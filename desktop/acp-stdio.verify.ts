import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeAcpStdio, runAcpStdio } from './acp-stdio.ts';
import type { CliStreamPayload } from './cli-agent.ts';

const fixture = resolve(fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url)));
const cwd = resolve(fileURLToPath(new URL('..', import.meta.url)));
const env = { ...process.env };

const probe = await probeAcpStdio({
  executable: process.execPath,
  args: [fixture, 'normal'],
  cwd,
  env,
  startupTimeoutMs: 5_000,
});
assert.equal(probe.compatible, true);
assert.equal(probe.protocolVersion, 1);
assert.equal(probe.name, 'CutAI Fake ACP');
assert.equal(probe.supportsHttpMcp, true);

const events: CliStreamPayload[] = [];
const result = await runAcpStdio({
  executable: process.execPath,
  args: [fixture, 'expect-mcp'],
  cwd,
  env,
  prompt: '测试',
  mcpUrl: 'http://127.0.0.1:3000/api/external-mcp/mcp?cutaiCliToken=test',
  signal: new AbortController().signal,
  onEvent: (event) => events.push(event),
});
assert.equal(result.text, '你好，权限已拒绝。');
assert.equal(result.reasoning, '检查中。');
assert.deepEqual(result.usage, { used: 12, size: 4096, cost: undefined });
assert.ok(events.some((event) => event.type === 'tool-start' && event.name === 'cutai.read_timeline'));
assert.ok(events.some((event) => event.type === 'tool-result' && event.toolId === 'tool-1'));

await assert.rejects(
  runAcpStdio({
    executable: process.execPath,
    args: [fixture, 'no-http'],
    cwd,
    env,
    prompt: '测试',
    mcpUrl: 'http://127.0.0.1/cutai',
    signal: new AbortController().signal,
  }),
  /does not advertise HTTP MCP support/,
);

const initializeStartedAt = Date.now();
await assert.rejects(
  runAcpStdio({
    executable: process.execPath,
    args: [fixture, 'hang-initialize'],
    cwd,
    env,
    prompt: '不应到达提示阶段',
    signal: new AbortController().signal,
    startupTimeoutMs: 1_000,
  }),
  /initialize handshake timed out/,
);
assert.ok(Date.now() - initializeStartedAt < 5_000, 'run startup timeout must not fall through to the 10 minute turn timeout');

const directory = await mkdtemp(join(tmpdir(), 'cutai-acp-cancel-'));
try {
  const marker = join(directory, 'cancel.txt');
  const controller = new AbortController();
  const cancelled = runAcpStdio({
    executable: process.execPath,
    args: [fixture, 'wait-cancel', marker],
    cwd,
    env,
    prompt: '等待取消',
    signal: controller.signal,
  });
  let markerText = '';
  for (let attempt = 0; attempt < 40 && !markerText.includes('prompt-started'); attempt += 1) {
    try { markerText = await readFile(marker, 'utf8'); } catch { /* wait for the child */ }
    if (!markerText.includes('prompt-started')) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.match(markerText, /prompt-started/);
  controller.abort();
  await assert.rejects(cancelled, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  for (let attempt = 0; attempt < 20 && !markerText.includes('cancel-received'); attempt += 1) {
    try { markerText = await readFile(marker, 'utf8'); } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 50)); }
    if (!markerText.includes('cancel-received')) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.match(markerText, /cancel-received/);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('ACP stdio adapter verification passed');
