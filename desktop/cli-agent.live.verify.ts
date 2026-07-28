import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliAgentHost } from './cli-agent.ts';
import { startEmbeddedServer } from './embedded-server.ts';
import { registerWorkspaceRoot } from './workspace-project.ts';

const temp = await mkdtemp(join(tmpdir(), 'cutai-cli-live-'));
const root = join(temp, '真实 CLI 工程');
await mkdir(join(root, '.cutai', 'audit'), { recursive: true });
await mkdir(join(root, '.cutai', 'sessions'), { recursive: true });
await writeFile(join(root, '.cutai', 'manifest.json'), '{}', 'utf8');
await writeFile(join(root, 'read-me.txt'), 'CUTAI_LOCAL_CLI_OK', 'utf8');
registerWorkspaceRoot('live-cli-test', root);

const host = new CliAgentHost(join(temp, 'user-data'));
const embedded = await startEmbeddedServer(join(process.cwd(), 'dist'));
host.setOrigin(embedded.origin);
const profiles = (await host.profiles()).filter(
  (profile) => profile.compatible && (!process.env.CUTAI_CLI_KIND || profile.kind === process.env.CUTAI_CLI_KIND),
);
for (const profile of profiles) {
  await host.authorize(profile.id, root, profile.fingerprint);
  const events: Array<{ type: string; at: number }> = [];
  const result = await host.run({
    profileId: profile.id,
    projectId: 'live-cli-test',
    projectRoot: root,
    prompt: 'Read read-me.txt in the current project and reply with only its exact contents. Do not edit anything and do not call CutAI tools.',
  }, (event) => events.push({ type: event.type, at: Date.now() }));
  assert.match(result.text, /CUTAI_LOCAL_CLI_OK/);
  assert.ok(result.sessionId, `${profile.name} did not return a resumable session id`);
  assert.ok(events.some((event) => event.type === 'status'), `${profile.name} did not emit lifecycle status`);
  assert.ok(events.some((event) => event.type === 'thinking'), `${profile.name} did not stream reasoning`);
  assert.ok(events.filter((event) => event.type === 'text').length > 1, `${profile.name} did not emit incremental assistant text`);

  const proofName = `direct-edit-${profile.kind}.txt`;
  await host.run({
    profileId: profile.id,
    projectId: 'live-cli-test',
    projectRoot: root,
    fileAccess: 'workspace-write',
    prompt: `Create ${proofName} in the current project with exactly DIRECT_EDIT_OK as its contents. Do not use CutAI tools.`,
  });
  assert.equal((await readFile(join(root, proofName), 'utf8')).trim(), 'DIRECT_EDIT_OK');
  console.log(`cli-agent.live.verify: ${profile.kind} ok (${result.sessionId})`);
}
host.close();
await new Promise<void>((resolveClose, reject) => embedded.server.close((error) => (
  error ? reject(error) : resolveClose()
)));
