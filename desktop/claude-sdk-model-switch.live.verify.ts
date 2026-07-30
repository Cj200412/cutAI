import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliAgentHost } from './cli-agent.ts';
import { registerWorkspaceRoot } from './workspace-project.ts';

const root = process.env.CUTAI_CLAUDE_TEST_PROJECT;
if (!root) throw new Error('CUTAI_CLAUDE_TEST_PROJECT is required');
const appData = process.env.APPDATA;
if (!appData) throw new Error('APPDATA is required');

const projectId = 'claude-sdk-model-switch-live';
registerWorkspaceRoot(projectId, root);
const host = new CliAgentHost(join(appData, 'CutAI'));
const profile = (await host.profiles()).find((item) => item.kind === 'claude');
if (!profile?.compatible) throw new Error(profile?.reason || 'Claude CLI is unavailable');
if (!profile.authorizedRoots.includes(root)) {
  await host.authorize(profile.id, root, profile.fingerprint);
}

const first = await host.run({
  profileId: profile.id,
  projectId,
  projectRoot: root,
  prompt: 'Reply with exactly FIRST_OK and do not use tools.',
  model: 'haiku',
  fileAccess: 'proposal-only',
});
assert.equal(first.text.includes('FIRST_OK'), true);
assert.ok(first.sessionId);
assert.ok(first.actualModel);

const second = await host.run({
  profileId: profile.id,
  projectId,
  projectRoot: root,
  prompt: 'Reply with exactly SECOND_OK and do not use tools.',
  sessionId: first.sessionId,
  model: 'sonnet',
  fileAccess: 'proposal-only',
});
assert.equal(second.text.includes('SECOND_OK'), true);
assert.equal(second.sessionId, first.sessionId, 'model switch must preserve the Claude session');
assert.ok(second.actualModel);
assert.notEqual(second.actualModel, first.actualModel, 'actual Claude model must change');

console.log(`claude-sdk-model-switch.live.verify: ok (${first.actualModel} -> ${second.actualModel}, session ${first.sessionId})`);
