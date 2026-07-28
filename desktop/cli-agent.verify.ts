import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliAgentHost } from './cli-agent.ts';

const temp = await mkdtemp(join(tmpdir(), 'cutai-cli-agent-'));
const workspace = join(temp, '中文 CLI 工程');
await mkdir(join(workspace, '.cutai', 'audit'), { recursive: true });
await writeFile(join(workspace, '.cutai', 'manifest.json'), '{}', 'utf8');

const host = new CliAgentHost(join(temp, 'user-data'));
const profiles = await host.profiles();
assert.equal(profiles.some((profile) => profile.kind === 'claude'), true);
assert.equal(profiles.some((profile) => profile.kind === 'codex'), true);

for (const profile of profiles.filter((item) => item.compatible)) {
  assert.equal(profile.executable.toLowerCase().endsWith('.exe'), true);
  assert.ok(profile.version);
  assert.equal(profile.fingerprint.length, 64);
  await host.authorize(profile.id, workspace, profile.fingerprint);
}

const refreshed = await host.profiles();
for (const profile of refreshed.filter((item) => item.compatible)) {
  assert.equal(profile.authorizedRoots.includes(workspace), true);
}
const audit = await readFile(join(workspace, '.cutai', 'audit', 'cli-authorizations.jsonl'), 'utf8');
assert.match(audit, /read-only-filesystem-and-cutai-proposals/);
assert.doesNotMatch(audit, /API_KEY|TOKEN/);
host.close();
console.log('cli-agent.verify: ok');
