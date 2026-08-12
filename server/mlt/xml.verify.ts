// Runnable check: `npx tsx server/mlt/xml.verify.ts`.
import assert from 'node:assert/strict';
import type { NeutralTimelineV1 } from '../../shared/neutral-timeline.ts';
import {
  analyzeMltCompatibility,
  convertNeutralTimelineToMltXml,
  MltCompatibilityError,
} from './xml.ts';

const timeline = {
  schema: 'cutai-neutral-timeline', version: 1,
  frameRate: { numerator: 30_000, denominator: 1_001 },
  canvas: { width: 1920, height: 1080, fit: 'contain' },
  durationFrames: 20,
  tracks: [
    {
      id: 'top', order: 0, kind: 'video', enabled: true, muted: false, locked: false,
      clips: [{
        id: 'top-image', name: 'A&B <image>', kind: 'image', startFrame: 3, durationFrames: 4,
        source: {
          uri: '/media/uploads/a&b.png', width: 1920, height: 1080,
          sourceInFrame: 2, playbackRate: 1,
        },
      }],
    },
    {
      id: 'bottom', order: 1, kind: 'video', enabled: true, muted: true, locked: false,
      clips: [{
        id: 'bottom-video', name: 'video', kind: 'video', startFrame: 0, durationFrames: 10,
        source: {
          uri: '/media/uploads/video.mp4', width: 1920, height: 1080,
          sourceInFrame: 5, playbackRate: 1,
        },
        audio: { volume: 1 },
      }],
    },
    {
      id: 'audio', order: 2, kind: 'audio', enabled: true, muted: false, locked: false,
      clips: [{
        id: 'voice', name: 'voice', kind: 'audio', startFrame: 5, durationFrames: 5,
        source: { uri: '/media/uploads/voice.wav', sourceInFrame: 0, playbackRate: 1 },
        audio: { volume: 1 },
      }],
    },
  ],
  transitions: [], diagnostics: [],
} satisfies NeutralTimelineV1;

const resources = [
  { uri: '/media/uploads/video.mp4', absolutePath: '/media/video.mp4', width: 1920, height: 1080 },
  { uri: '/media/uploads/a&b.png', absolutePath: `/media/A&B <素材> "quote" 'single'.png`, width: 1920, height: 1080 },
  { uri: '/media/uploads/voice.wav', absolutePath: '/media/voice.wav' },
];
const result = convertNeutralTimelineToMltXml(timeline, resources);
assert.equal(result.compatibility.compatible, true);
assert.match(result.xml, /frame_rate_num="30000" frame_rate_den="1001"/);
assert.match(result.xml, /display_aspect_num="16" display_aspect_den="9"/);
assert.match(result.xml, /\/media\/A&amp;B &lt;素材&gt; &quot;quote&quot; &apos;single&apos;\.png/);
assert.ok(result.xml.includes([
  '    <blank length="3"/>',
  '    <entry producer="producer_0000" in="2" out="5"/>',
  '    <blank length="13"/>',
].join('\n')));
assert.match(result.xml, /<entry producer="producer_0001" in="5" out="14"\/>/);
assert.ok(result.xml.includes([
  '      <track producer="playlist_0002"/>',
  '      <track producer="playlist_0001" hide="audio"/>',
  '      <track producer="playlist_0000"/>',
].join('\n')));
assert.equal((result.xml.match(/<property name="mlt_service">qtblend<\/property>/g) ?? []).length, 2);
assert.equal((result.xml.match(/<property name="mlt_service">mix<\/property>/g) ?? []).length, 3);
assert.equal(result.xml, convertNeutralTimelineToMltXml(timeline, [...resources].reverse()).xml);
const threaded = convertNeutralTimelineToMltXml(timeline, resources, { cpuThreads: 8 }).xml;
assert.equal(
  (threaded.match(/<property name="threads">1<\/property>/g) ?? []).length,
  3,
  'each decoder stays single-threaded so concurrent producers cannot multiply the task CPU budget',
);
assert.doesNotMatch(threaded, /<property name="threads">8<\/property>/);

const emptyCaption = structuredClone(timeline);
emptyCaption.tracks.push({
  id: 'empty-captions', order: 3, kind: 'caption', enabled: true, muted: false, locked: false,
  clips: [], captions: {
    presentation: { template: 'plain', pacing: 'phrase', bilingual: false },
    cues: [],
  },
});
assert.equal(
  analyzeMltCompatibility(emptyCaption, resources).compatible,
  true,
  'an enabled but empty caption lane has no rendered content and must not block basic export',
);
const captionWithMedia = structuredClone(emptyCaption);
captionWithMedia.tracks.at(-1)!.clips.push({
  id: 'hidden-in-caption', name: 'must-not-disappear', kind: 'video', startFrame: 0, durationFrames: 5,
  source: {
    uri: '/media/uploads/video.mp4', width: 1920, height: 1080,
    sourceInFrame: 0, playbackRate: 1,
  },
});
assert.ok(
  analyzeMltCompatibility(captionWithMedia, resources).blockers.some((blocker) =>
    blocker.code === 'clip-track-kind-mismatch' && blocker.message.includes('would omit')),
  'media clips on a caption track must fail closed instead of disappearing',
);

const unknownDimensions = structuredClone(timeline);
const unknownDimensionResources = resources.map((resource) => resource.uri === '/media/uploads/a&b.png'
  ? { uri: resource.uri, absolutePath: resource.absolutePath }
  : resource);
assert.ok(
  analyzeMltCompatibility(unknownDimensions, unknownDimensionResources).blockers.some((blocker) => blocker.code === 'source-dimensions'),
  'MLT must not guess canvas fit when source dimensions are unavailable',
);
const mismatchedDimensions = structuredClone(timeline);
const mismatchedResources = resources.map((resource) => resource.uri === '/media/uploads/a&b.png'
  ? { ...resource, width: 1080, height: 1920 }
  : resource);
const fitBlocker = analyzeMltCompatibility(mismatchedDimensions, mismatchedResources).blockers
  .find((blocker) => blocker.code === 'canvas-fit');
assert.match(fitBlocker?.message ?? '', /fit=contain is not implemented/);

const blocked = structuredClone(timeline);
blocked.tracks[0]!.clips[0]!.visual = { x: 10 };
blocked.tracks[0]!.clips[0]!.source!.playbackRate = 1.5;
blocked.tracks[0]!.clips.push({
  id: 'overlap', name: 'overlap', kind: 'video', startFrame: 5, durationFrames: 3,
  source: { uri: '/media/uploads/missing.mp4', sourceInFrame: 0, playbackRate: 1 },
});
blocked.tracks.push({
  id: 'captions', order: 3, kind: 'caption', enabled: true, muted: false, locked: false,
  clips: [], captions: {
    presentation: { template: 'plain', pacing: 'phrase', bilingual: false },
    cues: [{ id: 'cue', startFrame: 0, endFrameExclusive: 10, text: '字幕' }],
  },
});
blocked.transitions.push({
  id: 'shader', type: 'custom-shader', trackId: 'bottom', outgoingClipId: 'bottom-video',
  incomingClipId: 'bottom-video', durationFrames: 2, enabled: true,
  custom: { fragmentShader: 'void main() {}' },
});
const report = analyzeMltCompatibility(blocked, resources);
assert.equal(report.compatible, false);
for (const code of [
  'visual-adjustment', 'playback-rate', 'same-track-overlap', 'missing-resolved-resource',
  'caption-track', 'custom-transition',
]) assert.ok(report.blockers.some((blocker) => blocker.code === code), `expected blocker ${code}`);
assert.throws(
  () => convertNeutralTimelineToMltXml(blocked, resources),
  (error) => error instanceof MltCompatibilityError
    && error.report.blockers.length === report.blockers.length
    && error.message.includes('visual adjustments'),
);

const unsupported = structuredClone(timeline);
unsupported.tracks[0]!.clips[0]!.placeholder = { kind: 'missing-media', reason: 'not rendered' };
unsupported.tracks[0]!.clips[0]!.source = undefined;
unsupported.tracks[1]!.clips[0]!.source!.segments = [{
  timelineOffsetFrames: 0, sourceInFrame: 0, durationFrames: 10,
}];
unsupported.tracks[2]!.clips[0]!.keyframes = { volume: [{ frame: 0, value: 1 }] };
const unsupportedReport = analyzeMltCompatibility(unsupported, resources);
for (const code of ['placeholder', 'missing-source', 'source-segments', 'keyframes']) {
  assert.ok(unsupportedReport.blockers.some((blocker) => blocker.code === code), `expected blocker ${code}`);
}

console.log('MLT XML checks passed');
