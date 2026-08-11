// Runnable check: `npx tsx server/mlt/probe.verify.ts`.
import assert from 'node:assert/strict';
import {
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
assert.ok(maxActive <= 2, 'query concurrency must remain bounded');
assert.deepEqual(calls.map((call) => call.args), [
  ['-version'],
  ['-query', 'consumers'],
  ['-query', 'producers'],
  ['-query', 'filters'],
  ['-query', 'transitions'],
  ['-query', 'video_codecs'],
]);
assert.ok(calls.every((call) => call.executable === 'C:\\trusted\\melt.exe'));

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

const timedOut = await runBoundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  timeoutMs: 50, maxOutputBytes: 128, killGraceMs: 1_000,
});
assert.equal(timedOut.terminationReason, 'timeout');

const failed = await runBoundedProcess(process.execPath, ['-e', 'process.exit(7)'], {
  timeoutMs: 2_000, maxOutputBytes: 128,
});
assert.equal(failed.exitCode, 7);
assert.equal(failed.terminationReason, undefined);

console.log('MLT probe checks passed');
