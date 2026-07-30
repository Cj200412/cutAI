import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliAgentHost } from './cli-agent.ts';

const projectRoot = process.env.CUTAI_CLAUDE_TEST_PROJECT;
assert.ok(projectRoot, 'CUTAI_CLAUDE_TEST_PROJECT is required');
const appData = process.env.APPDATA;
assert.ok(appData, 'APPDATA is required');
const proofName = 'claude-sdk-stability-check.txt';
const before = await readFile(join(projectRoot, proofName), 'utf8');
const host = new CliAgentHost(join(appData, 'CutAI'));
const profile = (await host.profiles()).find((item) => item.kind === 'claude' && item.compatible);
assert.ok(profile, 'Claude Agent SDK profile is unavailable');
await host.authorize(profile.id, projectRoot, profile.fingerprint);
try {
  const result = await host.run({
    profileId: profile.id,
    projectId: 'claude-sdk-plan',
    projectRoot,
    fileAccess: 'workspace-write',
    planMode: true,
    prompt: `计划把 ${proofName} 改成 PLAN_MODE_MUST_NOT_WRITE，但计划模式下不要修改文件；只返回计划。`,
  });
  assert.ok(result.text.trim(), 'plan mode did not return a plan');
  assert.equal(await readFile(join(projectRoot, proofName), 'utf8'), before, 'plan mode modified a file');
  console.log('claude-sdk-plan.live.verify: ok');
} finally {
  host.close();
}
