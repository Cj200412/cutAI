// Runnable check: `npx tsx server/mlt/probe.verify.ts`.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mltExperimentalCpuExportCompatibilityFailure,
  mltProbeEnvironment,
  parseMltList,
  probeMlt,
  resolveMltExecutable,
  runBoundedProcess,
  type BoundedProcessResult,
  type MltProbeRunner,
} from './probe.ts';

const processResult = (stdout = '', overrides: Partial<BoundedProcessResult> = {}): BoundedProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout,
  stderr: '',
  durationMs: 2,
  truncated: false,
  ...overrides,
});

function processIsRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processIsRunning(pid);
}

function collectTreeProcessIds(raw: string | undefined, target: number[]): void {
  const record = raw?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!record) return;
  try {
    const value = JSON.parse(record) as { parentPid?: unknown; childPid?: unknown };
    for (const candidate of [value.parentPid, value.childPid]) {
      const pid = Number(candidate);
      if (Number.isSafeInteger(pid) && pid > 0 && !target.includes(pid)) target.push(pid);
    }
  } catch {
    // The assertions below report a missing record; cleanup remains best effort.
  }
}

async function forceCleanupProcess(pid: number): Promise<void> {
  if (!processIsRunning(pid)) return;
  try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  await waitForProcessExit(pid, 2_000);
}

assert.deepEqual(parseMltList(`
---
filters:
  - avfilter.eq
  - avfilter.eq
  - \u001b[32mqtext\u001b[0m
  - "opencv.tracker"
  - bad item with spaces
  key: ignored
`), ['avfilter.eq', 'opencv.tracker', 'qtext']);

const calls: Array<{ executable: string; args: readonly string[] }> = [];
let active = 0;
let maxActive = 0;
const runner: MltProbeRunner = async (executable, args) => {
  calls.push({ executable, args: [...args] });
  active += 1;
  maxActive = Math.max(maxActive, active);
  await new Promise((resolve) => setTimeout(resolve, 2));
  active -= 1;
  if (args[0] === '-version') return processResult('', { stderr: 'melt 7.40.0\nCopyright MLT' });
  const query = args[1];
  if (query === 'transitions') return processResult('', { exitCode: 2, stderr: 'transition registry unavailable' });
  const values: Record<string, string[]> = {
    consumers: ['avformat', 'xml', 'sdl2'],
    producers: ['avformat', 'color'],
    filters: ['qtext'],
    video_codecs: ['libx264', 'h264_nvenc', 'hevc_qsv', 'libx264_nvenc_fake'],
    audio_codecs: ['aac'],
    formats: ['mp4'],
  };
  return processResult(`${query}:\n${(values[query ?? ''] ?? []).map((item) => `  - ${item}`).join('\n')}\n`);
};

const report = await probeMlt({
  environment: { PATH: 'C:\\trusted', OPENAI_API_KEY: 'must-not-leak' },
  platform: 'win32',
  resolveExecutable: async () => ({ status: 'resolved', source: 'configured', resolvedPath: 'C:\\trusted\\melt.exe' }),
  runner,
});
assert.equal(report.availability, 'inspectable');
assert.equal(report.version, 'melt 7.40.0');
assert.equal(report.versionStatus, 'ok');
assert.equal(report.queries.transitions.status, 'failed');
assert.deepEqual(report.hardwareCodecCandidates, ['h264_nvenc', 'hevc_qsv']);
assert.deepEqual(report.checks, {
  avformatProducerReported: true,
  avformatConsumerReported: true,
  xmlConsumerReported: true,
});
assert.equal(report.renderVerified, false);
assert.equal(report.operationallyRendered, false);
assert.equal(report.selectableForExport, false);
assert.match(mltExperimentalCpuExportCompatibilityFailure(report) ?? '', /avformat, xml, and color producers/);
assert.ok(maxActive <= 2, 'query concurrency must remain bounded');
assert.deepEqual(calls.map((call) => call.args), [
  ['-version'],
  ['-query', 'consumers'],
  ['-query', 'producers'],
  ['-query', 'filters'],
  ['-query', 'transitions'],
  ['-query', 'video_codecs'],
  ['-query', 'audio_codecs'],
  ['-query', 'formats'],
]);
assert.ok(calls.every((call) => call.executable === 'C:\\trusted\\melt.exe'));

const eligibleReport = await probeMlt({
  resolveExecutable: async () => ({ status: 'resolved', source: 'path', resolvedPath: '/opt/bin/melt' }),
  runner: async (_executable, args) => {
    if (args[0] === '-version') return processResult('melt 7.40.0');
    const values: Record<string, string[]> = {
      consumers: ['avformat'],
      producers: ['avformat', 'color', 'xml'],
      filters: [],
      transitions: ['mix', 'qtblend'],
      video_codecs: ['libx264'],
      audio_codecs: ['aac'],
      formats: ['mp4'],
    };
    const query = args[1] ?? '';
    return processResult(`${query}:\n${(values[query] ?? []).map((item) => `  - ${item}`).join('\n')}\n`);
  },
});
assert.equal(eligibleReport.selectableForExport, true);
assert.equal(mltExperimentalCpuExportCompatibilityFailure(eligibleReport), undefined);
assert.equal(eligibleReport.renderVerified, false);
assert.equal(eligibleReport.operationallyRendered, false);

for (const [query, missingItem, expected] of [
  ['producers', 'xml', /avformat, xml, and color producers/],
  ['consumers', 'avformat', /avformat consumer/],
  ['transitions', 'qtblend', /qtblend and mix transitions/],
  ['video_codecs', 'libx264', /CPU libx264 encoder/],
  ['audio_codecs', 'aac', /AAC audio encoder/],
  ['formats', 'mp4', /MP4 muxer/],
] as const) {
  const ineligibleReport = structuredClone(eligibleReport);
  ineligibleReport.queries[query].items = ineligibleReport.queries[query].items.filter((item) => item !== missingItem);
  const failure = mltExperimentalCpuExportCompatibilityFailure(ineligibleReport);
  assert.match(failure ?? '', expected);
}

let versionOnlyCalls = 0;
const badVersion = await probeMlt({
  resolveExecutable: async () => ({ status: 'resolved', source: 'path', resolvedPath: '/opt/bin/melt' }),
  runner: async () => {
    versionOnlyCalls += 1;
    return processResult('', { exitCode: 1, stderr: 'broken runtime' });
  },
});
assert.equal(badVersion.availability, 'unusable');
assert.equal(versionOnlyCalls, 1, 'failed version must skip every query');
assert.ok(Object.values(badVersion.queries).every((query) => query.status === 'skipped'));

let impostorCalls = 0;
const impostor = await probeMlt({
  resolveExecutable: async () => ({ status: 'resolved', source: 'configured', resolvedPath: process.execPath }),
  runner: async () => {
    impostorCalls += 1;
    return processResult('v24.0.0');
  },
});
assert.equal(impostor.availability, 'unusable', 'an arbitrary executable version must not identify as melt');
assert.equal(impostorCalls, 1);

const configuredInjection = await resolveMltExecutable({ MLT_MELT_PATH: 'melt.exe --query consumers' }, 'win32');
assert.equal(configuredInjection.status, 'misconfigured');
const missing = await resolveMltExecutable({ PATH: ';.;relative' }, 'win32');
assert.equal(missing.status, 'not-found');

const childEnv = mltProbeEnvironment({
  PATH: 'safe-path',
  SystemRoot: 'C:\\Windows',
  MLT_DATA: 'C:\\mlt\\data',
  LC_MESSAGES: 'C',
  OPENAI_API_KEY: 'secret',
  ASSEMBLYAI_API_KEY: 'secret',
});
assert.equal(childEnv.PATH, 'safe-path');
assert.equal(childEnv.SystemRoot, 'C:\\Windows');
assert.equal(childEnv.MLT_DATA, 'C:\\mlt\\data');
assert.equal(childEnv.LC_MESSAGES, 'C');
assert.equal(childEnv.OPENAI_API_KEY, undefined);
assert.equal(childEnv.ASSEMBLYAI_API_KEY, undefined);

const success = await runBoundedProcess(process.execPath, ['-e', 'process.stdout.write("ok")'], {
  timeoutMs: 2_000, maxOutputBytes: 128,
});
assert.equal(success.exitCode, 0);
assert.equal(success.stdout, 'ok');

const excessive = await runBoundedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], {
  timeoutMs: 2_000, maxOutputBytes: 128,
});
assert.equal(excessive.terminationReason, 'output-limit');
assert.equal(excessive.truncated, true);
assert.ok(Buffer.byteLength(excessive.stdout) <= 128);

const treeDirectory = await mkdtemp(join(tmpdir(), 'cutai-mlt-probe-tree-'));
const treePidFile = join(treeDirectory, 'processes.json');
const treeProcessIds: number[] = [];
let timedOutTree: BoundedProcessResult | undefined;
try {
  const treeFixture = String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 15000); setInterval(() => {}, 1000)'], {
  windowsHide: true,
  stdio: 'ignore',
});
if (!descendant.pid) process.exit(2);
const record = JSON.stringify({ parentPid: process.pid, childPid: descendant.pid });
writeFileSync(process.argv[1], record, 'utf8');
process.stdout.write(record + '\n');
setTimeout(() => process.exit(0), 15000);
setInterval(() => {}, 1000);
`;
  timedOutTree = await runBoundedProcess(process.execPath, ['-e', treeFixture, treePidFile], {
    timeoutMs: 500,
    maxOutputBytes: 1_024,
    killGraceMs: 5_000,
  });
  assert.equal(timedOutTree.terminationReason, 'timeout');
  collectTreeProcessIds(await readFile(treePidFile, 'utf8'), treeProcessIds);
  assert.equal(treeProcessIds.length, 2, 'timeout fixture must report its parent and descendant process ids');
  for (const pid of treeProcessIds) {
    assert.equal(
      await waitForProcessExit(pid),
      true,
      `probe timeout must terminate process-tree member ${pid} on ${process.platform}`,
    );
  }
} finally {
  if (!treeProcessIds.length) {
    try { collectTreeProcessIds(await readFile(treePidFile, 'utf8'), treeProcessIds); } catch { /* fixture did not start */ }
    collectTreeProcessIds(timedOutTree?.stdout, treeProcessIds);
  }
  for (const pid of [...treeProcessIds].reverse()) await forceCleanupProcess(pid);
  await rm(treeDirectory, { recursive: true, force: true });
}

const abortController = new AbortController();
const abortedProcess = runBoundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  timeoutMs: 5_000,
  maxOutputBytes: 128,
  killGraceMs: 1_000,
  signal: abortController.signal,
});
setTimeout(() => abortController.abort(), 25);
assert.equal((await abortedProcess).terminationReason, 'aborted');

const failed = await runBoundedProcess(process.execPath, ['-e', 'process.exit(7)'], {
  timeoutMs: 2_000, maxOutputBytes: 128,
});
assert.equal(failed.exitCode, 7);
assert.equal(failed.terminationReason, undefined);

console.log('MLT probe checks passed');
