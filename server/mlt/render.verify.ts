// Runnable check: `npx tsx server/mlt/render.verify.ts`.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeutralTimelineV1 } from '../../shared/neutral-timeline.ts';
import type { ResolvedMltResource } from './media-resolver.ts';
import type { MltProbeReport } from './probe.ts';
import {
  MAX_MLT_CPU_THREADS,
  renderMltTimeline,
  runMltRenderProcess,
  type MltRenderProcessRunner,
} from './render.ts';

const testDirectory = await mkdtemp(join(tmpdir(), 'cutai-mlt-render-test-'));

function probeReport(overrides: Partial<MltProbeReport> = {}): MltProbeReport {
  return {
    backend: 'mlt',
    probeVersion: 1,
    mode: 'probe-only',
    availability: 'inspectable',
    executable: { source: 'configured', resolvedPath: process.execPath },
    version: 'melt 7.40.0',
    versionStatus: 'ok',
    queries: {
      consumers: { status: 'ok', items: ['avformat'], truncated: false },
      producers: { status: 'ok', items: ['avformat', 'xml', 'color'], truncated: false },
      filters: { status: 'ok', items: [], truncated: false },
      transitions: { status: 'ok', items: ['mix', 'qtblend'], truncated: false },
      video_codecs: { status: 'ok', items: ['libx264'], truncated: false },
      audio_codecs: { status: 'ok', items: ['aac'], truncated: false },
      formats: { status: 'ok', items: ['mp4'], truncated: false },
    },
    checks: {
      avformatProducerReported: true,
      avformatConsumerReported: true,
      xmlConsumerReported: false,
    },
    hardwareCodecCandidates: [],
    hardwareCodecStatus: 'reported-unverified',
    renderVerified: false,
    operationallyRendered: false,
    selectableForExport: true,
    diagnostics: [],
    ...overrides,
  };
}

const timeline: NeutralTimelineV1 = {
  schema: 'cutai-neutral-timeline',
  version: 1,
  frameRate: { numerator: 30, denominator: 1 },
  canvas: { width: 1920, height: 1080, fit: 'contain' },
  durationFrames: 30,
  tracks: [],
  transitions: [],
  diagnostics: [],
};
const resources: ResolvedMltResource[] = [];
const xmlDocument = '<?xml version="1.0"?><mlt></mlt>';
assert.equal(MAX_MLT_CPU_THREADS, 16);

try {
  const outputRoot = join(testDirectory, 'output');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(outputRoot));
  let calledExecutable = '';
  let calledArgs: readonly string[] = [];
  let calledXmlPath = '';
  const observedProgress: number[] = [];
  const successfulRunner: MltRenderProcessRunner = async (executable, args, options) => {
    calledExecutable = executable;
    calledArgs = [...args];
    calledXmlPath = args[0] ?? '';
    assert.equal(await readFile(calledXmlPath, 'utf8'), xmlDocument);
    assert.equal(options.env.OMP_NUM_THREADS, '2');
    assert.equal(options.env.OPENAI_API_KEY, undefined, 'secret environment must not reach melt');
    options.onProgress?.(0.15);
    options.onProgress?.(0.75);
    const consumer = args.find((arg) => arg.startsWith('avformat:'));
    assert.ok(consumer);
    await writeFile(consumer.slice('avformat:'.length), 'rendered-video');
    return {
      exitCode: 0,
      signal: null,
      stdoutTail: '',
      stderrTail: '',
      durationMs: 5,
      lastProgress: 0.75,
    };
  };
  const completed = await renderMltTimeline({
    timeline,
    resources,
    output: { rootDirectory: outputRoot, relativePath: 'completed.mp4' },
    settings: { cpuThreads: 2, timeoutMs: 5_000 },
    onProgress: (progress) => observedProgress.push(progress),
  }, {
    environment: { PATH: process.env.PATH, OPENAI_API_KEY: 'must-not-leak' },
    probe: async () => probeReport(),
    convert: () => ({ xml: xmlDocument, compatibility: { compatible: true, blockers: [], warnings: [] } }),
    processRunner: successfulRunner,
  });
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(completed.lastProgress, 1);
  assert.equal(await readFile(join(outputRoot, 'completed.mp4'), 'utf8'), 'rendered-video');
  assert.equal(calledExecutable, process.execPath);
  assert.equal(calledArgs[0], calledXmlPath);
  assert.deepEqual(calledArgs.slice(1), [
    '-consumer',
    calledArgs[2],
    'f=mp4',
    'vcodec=libx264',
    'acodec=aac',
    'preset=veryfast',
    'crf=20',
    'ab=192k',
    'movflags=+faststart',
    'threads=2',
    'real_time=-1',
    'progress=1',
    '-progress2',
  ]);

  const publicationAbort = new AbortController();
  const cancelledDuringPublish = await renderMltTimeline({
    timeline,
    resources,
    output: { rootDirectory: outputRoot, relativePath: 'cancelled-during-publish.mp4' },
    signal: publicationAbort.signal,
  }, {
    probe: async () => probeReport(),
    convert: () => ({ xml: xmlDocument, compatibility: { compatible: true, blockers: [], warnings: [] } }),
    processRunner: async (_executable, args) => {
      const consumer = args.find((arg) => arg.startsWith('avformat:'));
      assert.ok(consumer);
      await writeFile(consumer.slice('avformat:'.length), 'rendered-then-cancelled');
      publicationAbort.abort();
      return { exitCode: 0, signal: null, stdoutTail: '', stderrTail: '', durationMs: 1, lastProgress: 1 };
    },
  });
  assert.equal(cancelledDuringPublish.status, 'cancelled');
  await assert.rejects(
    () => access(join(outputRoot, 'cancelled-during-publish.mp4'), constants.F_OK),
    /ENOENT/,
  );

  const probeAbort = new AbortController();
  let probeSawSignal: AbortSignal | undefined;
  const probeStarted = Promise.withResolvers<void>();
  const cancelledDuringProbePromise = renderMltTimeline({
    timeline,
    resources,
    output: { rootDirectory: outputRoot, relativePath: 'cancelled-during-probe.mp4' },
    signal: probeAbort.signal,
  }, {
    probe: async (signal) => {
      probeSawSignal = signal;
      probeStarted.resolve();
      await new Promise<void>((_resolve, reject) => signal?.addEventListener(
        'abort',
        () => reject(new DOMException('probe cancelled', 'AbortError')),
        { once: true },
      ));
      return probeReport();
    },
  });
  await probeStarted.promise;
  probeAbort.abort();
  const cancelledDuringProbe = await cancelledDuringProbePromise;
  assert.equal(probeSawSignal?.aborted, true, 'render cancellation must reach the active MLT probe');
  assert.equal(cancelledDuringProbe.status, 'cancelled');
  assert.ok(calledArgs[2]?.startsWith('avformat:'));
  await assert.rejects(access(calledXmlPath, constants.F_OK), { code: 'ENOENT' });
  assert.deepEqual(observedProgress, [0.15, 0.75, 1]);
  assert.ok(!(await readdir(outputRoot)).some((name) => name.includes('.partial-')));

  let unavailableSpawned = false;
  const unavailable = await renderMltTimeline({
    timeline,
    resources,
    output: { rootDirectory: outputRoot, relativePath: 'unavailable.mp4' },
  }, {
    probe: async () => probeReport({ availability: 'not-found', executable: { source: 'none' } }),
    convert: () => ({ xml: xmlDocument, compatibility: { compatible: true, blockers: [], warnings: [] } }),
    processRunner: async () => {
      unavailableSpawned = true;
      throw new Error('must not run');
    },
  });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailableSpawned, false, 'missing melt must never enter the render process runner');

  let incompatibleSpawned = false;
  const incompatible = await renderMltTimeline({
    timeline,
    resources,
    output: { rootDirectory: outputRoot, relativePath: 'incompatible.mp4' },
  }, {
    probe: async () => probeReport({
      queries: {
        ...probeReport().queries,
        transitions: { status: 'ok', items: ['mix'], truncated: false },
      },
    }),
    convert: () => ({ xml: xmlDocument, compatibility: { compatible: true, blockers: [], warnings: [] } }),
    processRunner: async () => {
      incompatibleSpawned = true;
      throw new Error('must not run');
    },
  });
  assert.equal(incompatible.status, 'unavailable');
  assert.equal(incompatibleSpawned, false, 'incompatible melt must never enter the render process runner');

  const missingColor = await renderMltTimeline({
    timeline,
    resources,
    output: { rootDirectory: outputRoot, relativePath: 'missing-color.mp4' },
  }, {
    probe: async () => probeReport({
      queries: {
        ...probeReport().queries,
        producers: { status: 'ok', items: ['avformat', 'xml'], truncated: false },
      },
    }),
    convert: () => ({ xml: xmlDocument, compatibility: { compatible: true, blockers: [], warnings: [] } }),
    processRunner: async () => { throw new Error('must not run'); },
  });
  assert.equal(missingColor.status, 'unavailable');
  assert.match(missingColor.diagnostics[0]?.message ?? '', /color/);

  let unsafeProbeCalls = 0;
  const unsafeOutput = await renderMltTimeline({
    timeline,
    resources,
    output: { rootDirectory: outputRoot, relativePath: '../escape.mp4' },
  }, {
    probe: async () => {
      unsafeProbeCalls += 1;
      return probeReport();
    },
  });
  assert.equal(unsafeOutput.status, 'failed');
  assert.equal(unsafeProbeCalls, 0, 'unsafe output must fail before probing or starting melt');

  const failure = await renderMltTimeline({
    timeline,
    resources,
    output: { rootDirectory: outputRoot, relativePath: 'failed.mp4' },
  }, {
    probe: async () => probeReport(),
    convert: () => ({ xml: xmlDocument, compatibility: { compatible: true, blockers: [], warnings: [] } }),
    processRunner: async (_executable, args) => {
      const consumer = args.find((arg) => arg.startsWith('avformat:'))!;
      await writeFile(consumer.slice('avformat:'.length), 'incomplete');
      return {
        exitCode: 7,
        signal: null,
        stdoutTail: '',
        stderrTail: 'fake melt failed',
        durationMs: 2,
        lastProgress: 0.4,
      };
    },
  });
  assert.equal(failure.status, 'failed');
  await assert.rejects(access(join(outputRoot, 'failed.mp4'), constants.F_OK), { code: 'ENOENT' });
  assert.ok(!(await readdir(outputRoot)).some((name) => name.includes('.partial-')));

  const incompatibleTimeline = structuredClone(timeline);
  incompatibleTimeline.tracks.push({
    id: 'captions', order: 0, kind: 'caption', enabled: true, muted: false, locked: false,
    clips: [], captions: {
      presentation: { template: 'plain', pacing: 'phrase', bilingual: false },
      cues: [{ id: 'cue', startFrame: 0, endFrameExclusive: 10, text: '字幕' }],
    },
  });
  const incompatibleTimelineResult = await renderMltTimeline({
    timeline: incompatibleTimeline,
    resources,
    output: { rootDirectory: outputRoot, relativePath: 'caption-blocked.mp4' },
  }, { probe: async () => probeReport() });
  assert.equal(incompatibleTimelineResult.status, 'failed');
  assert.match(incompatibleTimelineResult.diagnostics[0]?.message ?? '', /Caption track captions/);

  const fixture = join(testDirectory, 'fake-melt.mjs');
  await writeFile(fixture, `
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
const mode = process.argv[2];
if (mode === 'progress') {
  process.stderr.write('Current Frame: 3, percentage: 12\\r');
  setTimeout(() => { process.stderr.write('percentage: 88\\n'); }, 10);
  setTimeout(() => process.exit(0), 20);
} else if (mode === 'tree') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await writeFile(process.argv[3], String(child.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'stubborn-tree') {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  await writeFile(process.argv[3], String(child.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'flood') {
  process.stdout.write('x'.repeat(8192));
  setInterval(() => {}, 1000);
} else {
  setInterval(() => {}, 1000);
}
`, 'utf8');

  const parsedProgress: number[] = [];
  const progressProcess = await runMltRenderProcess(process.execPath, [fixture, 'progress'], {
    cwd: testDirectory,
    env: process.env,
    timeoutMs: 2_000,
    onProgress: (progress) => parsedProgress.push(progress),
  });
  assert.equal(progressProcess.exitCode, 0);
  assert.equal(progressProcess.lastProgress, 0.88);
  assert.deepEqual(parsedProgress, [0.12, 0.88]);

  const controller = new AbortController();
  const childPidFile = join(testDirectory, 'tree-child.pid');
  const cancelledPromise = runMltRenderProcess(process.execPath, [fixture, 'tree', childPidFile], {
    cwd: testDirectory,
    env: process.env,
    signal: controller.signal,
    timeoutMs: 5_000,
    killGraceMs: 500,
  });
  let childPid = 0;
  for (let attempt = 0; attempt < 50 && !childPid; attempt += 1) {
    try { childPid = Number(await readFile(childPidFile, 'utf8')); } catch { /* fixture is starting */ }
    if (!childPid) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.ok(childPid > 0, 'fake melt must start a descendant before cancellation');
  controller.abort();
  const cancelled = await cancelledPromise;
  assert.equal(cancelled.terminationReason, 'aborted');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(childPid, 0);
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    } catch {
      childPid = 0;
      break;
    }
  }
  if (childPid) {
    try { process.kill(childPid, 'SIGKILL'); } catch { /* already exited */ }
  }
  assert.equal(childPid, 0, 'cancelling melt must terminate its descendant process tree');

  if (process.platform !== 'win32') {
    const stubbornController = new AbortController();
    const stubbornPidFile = join(testDirectory, 'stubborn-tree-child.pid');
    const stubbornPromise = runMltRenderProcess(process.execPath, [fixture, 'stubborn-tree', stubbornPidFile], {
      cwd: testDirectory,
      env: process.env,
      signal: stubbornController.signal,
      timeoutMs: 5_000,
      killGraceMs: 100,
    });
    let stubbornPid = 0;
    for (let attempt = 0; attempt < 50 && !stubbornPid; attempt += 1) {
      try { stubbornPid = Number(await readFile(stubbornPidFile, 'utf8')); } catch { /* fixture is starting */ }
      if (!stubbornPid) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    assert.ok(stubbornPid > 0, 'fake melt must start a SIGTERM-resistant descendant');
    stubbornController.abort();
    const stubbornCancelled = await stubbornPromise;
    assert.equal(stubbornCancelled.terminationReason, 'aborted');
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        process.kill(stubbornPid, 0);
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      } catch {
        stubbornPid = 0;
        break;
      }
    }
    if (stubbornPid) {
      try { process.kill(stubbornPid, 'SIGKILL'); } catch { /* already exited */ }
    }
    assert.equal(stubbornPid, 0, 'the forced group kill must outlive a leader that exits on SIGTERM');
  }

  const excessive = await runMltRenderProcess(process.execPath, [fixture, 'flood'], {
    cwd: testDirectory,
    env: process.env,
    timeoutMs: 2_000,
    maxOutputBytes: 128,
    killGraceMs: 500,
  });
  assert.equal(excessive.terminationReason, 'output-limit');
  assert.ok(Buffer.byteLength(excessive.stdoutTail) <= 64 * 1024);

  const timedOut = await runMltRenderProcess(process.execPath, [fixture, 'wait'], {
    cwd: testDirectory,
    env: process.env,
    timeoutMs: 50,
    killGraceMs: 500,
  });
  assert.equal(timedOut.terminationReason, 'timeout');

  console.log('MLT controlled render checks passed');
} finally {
  await rm(testDirectory, { recursive: true, force: true });
}
