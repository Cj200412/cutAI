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

const aliases = ['haiku', 'opus', 'fable', 'sonnet'].filter((id) => profile.models.some((model) => model.id === id));
assert.ok(aliases.length >= 2, 'at least two Claude model aliases are required');
let sessionId: string | undefined;
const actualModels: string[] = [];
for (const [index, model] of aliases.entries()) {
  const result = await host.run({
    profileId: profile.id,
    projectId,
    projectRoot: root,
    prompt: `Reply with exactly MODEL_SWITCH_${index + 1}_OK and do not use tools.`,
    ...(sessionId ? { sessionId } : {}),
    model,
    fileAccess: 'proposal-only',
  });
  assert.equal(result.text.includes(`MODEL_SWITCH_${index + 1}_OK`), true);
  if (sessionId) assert.equal(result.sessionId, sessionId, 'model switch must preserve the Claude session');
  sessionId = result.sessionId;
  assert.ok(result.actualModel);
  actualModels.push(result.actualModel);
}
assert.equal(new Set(actualModels).size, aliases.length, 'every configured alias must select a distinct actual model');

console.log(`claude-sdk-model-switch.live.verify: ok (${aliases.map((alias, index) => `${alias}=${actualModels[index]}`).join(', ')}, session ${sessionId})`);
