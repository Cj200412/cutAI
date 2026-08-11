import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliAgentHost } from './cli-agent.ts';
import { registerWorkspaceRoot } from './workspace-project.ts';

const projectRoot = process.env.CUTAI_CLAUDE_TEST_PROJECT;
assert.ok(projectRoot, 'CUTAI_CLAUDE_TEST_PROJECT is required');
const appData = process.env.APPDATA;
assert.ok(appData, 'APPDATA is required');
registerWorkspaceRoot('claude-sdk-stability', projectRoot);

const host = new CliAgentHost(join(appData, 'CutAI'));
const profile = (await host.profiles()).find((item) => item.kind === 'claude' && item.compatible);
assert.ok(profile, 'Claude Agent SDK profile is unavailable');
await host.authorize(profile.id, projectRoot, profile.fingerprint);

const proofName = 'claude-sdk-stability-check.txt';
const turnCount = Number.parseInt(process.env.CUTAI_CLAUDE_TEST_TURNS || '5', 10);
assert.ok(Number.isInteger(turnCount) && turnCount > 0, 'CUTAI_CLAUDE_TEST_TURNS must be a positive integer');
let sessionId: string | undefined;
for (let turn = 1; turn <= turnCount; turn += 1) {
  const expected = `CLAUDE_SDK_STABILITY_TURN_${turn}`;
  const events: string[] = [];
  const toolNames: string[] = [];
  const result = await host.run({
    profileId: profile.id,
    projectId: 'claude-sdk-stability',
    projectRoot,
    sessionId,
    fileAccess: 'workspace-write',
    prompt: `Use the Edit or Write tool to make ${proofName} contain exactly ${expected}. Then reply with exactly ${expected}.`,
  }, (event) => {
    events.push(event.type);
    if (event.type === 'tool-start') toolNames.push(event.name);
  });
  sessionId = result.sessionId;
  assert.ok(sessionId, `turn ${turn} did not return a session id`);
  assert.match(result.text, new RegExp(expected), `turn ${turn} final response mismatch`);
  assert.equal((await readFile(join(projectRoot, proofName), 'utf8')).trim(), expected, `turn ${turn} file mismatch`);
  assert.ok(events.includes('tool-start'), `turn ${turn} did not emit tool-start`);
  assert.ok(events.includes('tool-result'), `turn ${turn} did not emit tool-result`);
  assert.ok(events.includes('text'), `turn ${turn} did not emit text`);
  assert.equal(toolNames.some((name) => name.startsWith('mcp__')), false, `turn ${turn} unexpectedly used MCP`);
  console.log(`claude-sdk-project.live.verify: turn ${turn} ok (${events.length} UI events)`);
}

const guideRoot = join(projectRoot, '.cutai', 'agent-guides');
assert.match(await readFile(join(guideRoot, 'README.md'), 'utf8'), /每次任务的最短路径/);
assert.match(await readFile(join(guideRoot, 'project-format.md'), 'utf8'), /activeTimelineId/);
assert.match(await readFile(join(guideRoot, 'motion-graphics.md'), 'utf8'), /AbsoluteFill/);

const cancelRunId = 'claude-sdk-cancel-after-write';
const cancelExpected = 'CLAUDE_SDK_CANCEL_WRITE_COMPLETED';
let cancellationRequested = false;
await assert.rejects(host.run({
  runId: cancelRunId,
  profileId: profile.id,
  projectId: 'claude-sdk-stability',
  projectRoot,
  sessionId,
  fileAccess: 'workspace-write',
  prompt: `First update ${proofName} to exactly ${cancelExpected}. Then write a very long explanation of at least 3000 words.`,
}, (event) => {
  if (event.type === 'tool-result' && !cancellationRequested) {
    cancellationRequested = true;
    queueMicrotask(() => host.cancel(cancelRunId));
  }
}));
assert.equal(cancellationRequested, true, 'cancel test never reached a completed tool');
assert.equal((await readFile(join(projectRoot, proofName), 'utf8')).trim(), cancelExpected);

const recoveryExpected = 'CLAUDE_SDK_RECOVERED_AFTER_CANCEL';
const recovery = await host.run({
  profileId: profile.id,
  projectId: 'claude-sdk-stability',
  projectRoot,
  fileAccess: 'workspace-write',
  prompt: `Update ${proofName} to exactly ${recoveryExpected}, then reply with exactly ${recoveryExpected}.`,
});
assert.match(recovery.text, new RegExp(recoveryExpected));
assert.equal((await readFile(join(projectRoot, proofName), 'utf8')).trim(), recoveryExpected);
console.log('claude-sdk-project.live.verify: cancel and recovery ok');
host.close();
