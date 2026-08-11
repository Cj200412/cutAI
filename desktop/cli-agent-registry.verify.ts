import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliAgentHost } from './cli-agent.ts';
import { registerWorkspaceRoot } from './workspace-project.ts';

const directory = await mkdtemp(join(tmpdir(), 'cutai-custom-cli-'));
const previousAllowedEnv = process.env.CUTAI_TEST_ALLOWED_ENV;
const previousProxyEnv = process.env.HTTP_PROXY;
process.env.CUTAI_TEST_ALLOWED_ENV = 'explicitly-allowed';
process.env.HTTP_PROXY = 'http://user:secret@127.0.0.1:65535';
try {
  const userData = join(directory, 'user-data');
  const workspace = join(directory, '工程 含 空格');
  await mkdir(userData, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(userData, 'cli-agents.json'), JSON.stringify({
    authorizations: {
      legacy: { fingerprint: 'legacy-fingerprint', roots: [workspace], updatedAt: '2026-01-01T00:00:00.000Z' },
    },
  }), 'utf8');
  const fixture = resolve(fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url)));
  const host = new CliAgentHost(userData);
  const created = await host.createCustomProfile({
    name: '本地 ACP',
    executable: process.execPath,
    args: [fixture, 'report-env', ';&| shell metacharacters stay one argument'],
    envAllowlist: ['CUTAI_TEST_ALLOWED_ENV'],
    startupTimeoutMs: 5_000,
  });
  assert.equal(created.kind, 'custom-acp');
  assert.equal(created.compatible, false, 'a custom executable is disabled until an ACP handshake succeeds');
  assert.match(created.reason ?? '', /ACP/);

  const probed = await host.probeCustomProfile(created.id);
  assert.equal(probed.compatible, true);
  assert.equal(probed.supportsHttpMcp, true);
  assert.equal(probed.adapter, 'acp-stdio');
  assert.equal(probed.fingerprint.length, 64);

  await host.authorize(probed.id, workspace, probed.fingerprint);
  registerWorkspaceRoot('custom-acp-project', workspace);
  const result = await host.run({
    profileId: probed.id,
    projectId: 'custom-acp-project',
    projectRoot: workspace,
    prompt: '你好',
  });
  assert.deepEqual(JSON.parse(result.text), {
    allowed: 'explicitly-allowed',
    proxyPresent: false,
  }, 'custom ACP inherits explicit variables but not credential-bearing proxy variables unless listed');
  assert.equal(result.sessionId, undefined, 'generic ACP sessions are not assumed to support resume');

  const registryPath = join(userData, 'cli-agents.json');
  const staleProbeRegistry = JSON.parse(await readFile(registryPath, 'utf8')) as {
    customProfiles: Array<{ id: string; args: string[] }>;
  };
  const staleProbeProfile = staleProbeRegistry.customProfiles.find((profile) => profile.id === probed.id)!;
  staleProbeProfile.args = [fixture, 'no-http'];
  await writeFile(registryPath, JSON.stringify(staleProbeRegistry), 'utf8');
  const staleProbe = (await host.profiles()).find((profile) => profile.id === probed.id)!;
  assert.equal(staleProbe.compatible, false, 'a probe cannot be reused after the executable or launch configuration changes');
  assert.match(staleProbe.reason ?? '', /重新测试 ACP 握手/);

  const updated = await host.updateCustomProfile(probed.id, {
    name: '本地 ACP（已更新）',
    executable: process.execPath,
    args: [fixture, 'no-http'],
    envAllowlist: [],
    startupTimeoutMs: 5_000,
  });
  assert.equal(updated.compatible, false, 'editing launch settings requires another handshake');
  const reprobed = await host.probeCustomProfile(updated.id);
  assert.equal(reprobed.compatible, true);
  assert.equal(reprobed.supportsHttpMcp, false);
  assert.deepEqual(reprobed.authorizedRoots, [], 'configuration fingerprint changes invalidate prior authorization');

  const immediateCloseMarker = join(directory, 'immediate-close-start.txt');
  const immediateCloseProfile = await host.createCustomProfile({
    name: '立即关闭竞态测试',
    executable: process.execPath,
    args: [fixture, 'mark-start', immediateCloseMarker],
    envAllowlist: [],
    startupTimeoutMs: 5_000,
  });
  const immediateCloseProbe = await host.probeCustomProfile(immediateCloseProfile.id);
  await host.authorize(immediateCloseProbe.id, workspace, immediateCloseProbe.fingerprint);
  await rm(immediateCloseMarker, { force: true });
  const immediateCloseHost = new CliAgentHost(userData);
  const immediateCloseRun = immediateCloseHost.run({
    profileId: immediateCloseProbe.id,
    projectId: 'custom-acp-project',
    projectRoot: workspace,
    prompt: '不得在关闭完成后启动',
  });
  await immediateCloseHost.close();
  await assert.rejects(immediateCloseRun, /CutAI is closing/);
  await assert.rejects(
    readFile(immediateCloseMarker, 'utf8'),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    'run invoked immediately before close must not start an ACP process after close completes',
  );

  const closeMarker = join(directory, 'close-cancel.txt');
  const closingProfile = await host.updateCustomProfile(reprobed.id, {
    name: '本地 ACP（关闭测试）',
    executable: process.execPath,
    args: [fixture, 'wait-cancel', closeMarker],
    envAllowlist: [],
    startupTimeoutMs: 5_000,
  });
  const closingProbe = await host.probeCustomProfile(closingProfile.id);
  await host.authorize(closingProbe.id, workspace, closingProbe.fingerprint);
  const duplicateHost = new CliAgentHost(userData);
  const duplicateRequest = {
    runId: 'duplicate-custom-run',
    profileId: closingProbe.id,
    projectId: 'custom-acp-project',
    projectRoot: workspace,
    prompt: '相同 runId 只能启动一次',
  };
  const duplicateOutcomesPromise = Promise.allSettled([
    duplicateHost.run(duplicateRequest),
    duplicateHost.run(duplicateRequest),
  ]);
  let duplicateMarkerText = '';
  for (let attempt = 0; attempt < 40 && !duplicateMarkerText.includes('prompt-started'); attempt += 1) {
    try { duplicateMarkerText = await readFile(closeMarker, 'utf8'); } catch { /* child has not written yet */ }
    if (!duplicateMarkerText.includes('prompt-started')) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.match(duplicateMarkerText, /prompt-started/, 'one concurrent run reaches the ACP prompt');
  assert.equal(duplicateHost.cancel(duplicateRequest.runId), true);
  const duplicateOutcomes = await duplicateOutcomesPromise;
  const duplicateErrors = duplicateOutcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : []);
  assert.equal(duplicateErrors.length, 2);
  assert.equal(duplicateErrors.filter((error) => error instanceof Error && /already active/.test(error.message)).length, 1);
  assert.equal(duplicateErrors.filter((error) => error instanceof Error && error.name === 'AbortError').length, 1);
  await duplicateHost.close();
  await rm(closeMarker, { force: true });
  const hangingProfile = await host.createCustomProfile({
    name: '关闭时握手中的 ACP',
    executable: process.execPath,
    args: [fixture, 'hang-initialize'],
    envAllowlist: [],
    startupTimeoutMs: 60_000,
  });
  const hangingProbe = host.probeCustomProfile(hangingProfile.id);
  const hangingProbeOutcome = hangingProbe.then(
    () => undefined,
    (error: unknown) => error,
  );
  const closingRun = host.run({
    profileId: closingProbe.id,
    projectId: 'custom-acp-project',
    projectRoot: workspace,
    prompt: '等待应用关闭',
  });
  const closingOutcome = closingRun.then(
    () => undefined,
    (error: unknown) => error,
  );
  let closeMarkerText = '';
  for (let attempt = 0; attempt < 40 && !closeMarkerText.includes('prompt-started'); attempt += 1) {
    try { closeMarkerText = await readFile(closeMarker, 'utf8'); } catch { /* child has not written yet */ }
    if (!closeMarkerText.includes('prompt-started')) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.match(closeMarkerText, /prompt-started/);
  const closeStartedAt = Date.now();
  await host.close();
  assert.ok(Date.now() - closeStartedAt < 5_000, 'host close waits for ACP cancellation without hanging Electron quit');
  const closingError = await closingOutcome;
  assert.ok(closingError instanceof Error && closingError.name === 'AbortError');
  const hangingProbeError = await hangingProbeOutcome;
  assert.ok(
    hangingProbeError instanceof Error && hangingProbeError.name === 'AbortError',
    'host close aborts and waits for an in-progress ACP handshake probe',
  );
  closeMarkerText = await readFile(closeMarker, 'utf8');
  assert.match(closeMarkerText, /cancel-received/, 'host close sends ACP session/cancel before terminating the child');
  await assert.rejects(host.probeCustomProfile(closingProbe.id), /CutAI is closing/);
  await assert.rejects(host.run({
    profileId: closingProbe.id,
    projectId: 'custom-acp-project',
    projectRoot: workspace,
    prompt: '关闭后不得启动',
  }), /CutAI is closing/);

  const restartedHost = new CliAgentHost(userData);
  await restartedHost.deleteCustomProfile(closingProbe.id);
  await restartedHost.deleteCustomProfile(hangingProfile.id);
  await restartedHost.deleteCustomProfile(immediateCloseProbe.id);
  assert.equal((await restartedHost.profiles()).some((profile) => profile.id === closingProbe.id), false);
  await assert.rejects(restartedHost.deleteCustomProfile('codex-local'), /cannot be deleted/);
  await restartedHost.close();
  const registry = await readFile(registryPath, 'utf8');
  assert.match(registry, /"schemaVersion": 2/);
  assert.match(registry, /legacy-fingerprint/, 'v1 authorization data survives the v2 registry migration');
  assert.doesNotMatch(registry, /权限已拒绝/);
} finally {
  if (previousAllowedEnv === undefined) delete process.env.CUTAI_TEST_ALLOWED_ENV;
  else process.env.CUTAI_TEST_ALLOWED_ENV = previousAllowedEnv;
  if (previousProxyEnv === undefined) delete process.env.HTTP_PROXY;
  else process.env.HTTP_PROXY = previousProxyEnv;
  await rm(directory, { recursive: true, force: true });
}

console.log('custom ACP registry verification passed');
