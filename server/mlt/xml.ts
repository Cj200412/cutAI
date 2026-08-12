import { isAbsolute } from 'node:path';
import {
  neutralTimelineV1Errors,
  type NeutralClipV1,
  type NeutralTimelineV1,
  type NeutralTrackV1,
} from '../../shared/neutral-timeline.ts';
import type { ResolvedMltResource } from './media-resolver.ts';

export type MltCompatibilityIssueCode =
  | 'invalid-timeline'
  | 'timeline-error'
  | 'upstream-unsupported-feature'
  | 'duplicate-resource'
  | 'invalid-resource-path'
  | 'unused-resource'
  | 'caption-track'
  | 'placeholder'
  | 'missing-source'
  | 'missing-resolved-resource'
  | 'unsupported-clip-kind'
  | 'clip-track-kind-mismatch'
  | 'same-track-overlap'
  | 'playback-rate'
  | 'source-segments'
  | 'alternate-audio'
  | 'source-dimensions'
  | 'canvas-fit'
  | 'visual-adjustment'
  | 'keyframes'
  | 'audio-adjustment'
  | 'audio-routing'
  | 'custom-transition'
  | 'unsupported-transition';

export interface MltCompatibilityIssue {
  code: MltCompatibilityIssueCode;
  message: string;
  trackId?: string;
  clipId?: string;
  transitionId?: string;
  uri?: string;
}

export interface MltCompatibilityReport {
  compatible: boolean;
  blockers: MltCompatibilityIssue[];
  warnings: MltCompatibilityIssue[];
}

export interface MltXmlResult {
  xml: string;
  compatibility: MltCompatibilityReport;
}

export class MltCompatibilityError extends Error {
  readonly report: MltCompatibilityReport;

  constructor(report: MltCompatibilityReport) {
    const summary = report.blockers.slice(0, 3).map((blocker) => blocker.message).join('; ');
    const remaining = Math.max(0, report.blockers.length - 3);
    super([
      `Timeline is not compatible with the MLT XML backend (${report.blockers.length} blocker(s))`,
      summary,
      remaining ? `${remaining} more blocker(s)` : '',
    ].filter(Boolean).join(': '));
    this.name = 'MltCompatibilityError';
    this.report = report;
  }
}

const SUPPORTED_CLIP_KINDS = new Set<NeutralClipV1['kind']>(['video', 'image', 'audio']);

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function containsInvalidXmlCharacter(value: string): boolean {
  for (let index = 0; index < value.length;) {
    const codePoint = value.codePointAt(index)!;
    const valid = codePoint === 0x09 || codePoint === 0x0A || codePoint === 0x0D
      || (codePoint >= 0x20 && codePoint <= 0xD7FF)
      || (codePoint >= 0xE000 && codePoint <= 0xFFFD)
      || (codePoint >= 0x10000 && codePoint <= 0x10FFFF);
    if (!valid) return true;
    index += codePoint > 0xFFFF ? 2 : 1;
  }
  return false;
}

function isPortableAbsolutePath(value: string): boolean {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\]/u.test(value);
}

function escapeXml(value: string): string {
  if (containsInvalidXmlCharacter(value)) throw new Error('value contains a character forbidden by XML 1.0');
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function sortedTracks(timeline: NeutralTimelineV1): NeutralTrackV1[] {
  return [...timeline.tracks].sort((left, right) => left.order - right.order || compareStrings(left.id, right.id));
}

function sortedClips(track: NeutralTrackV1): NeutralClipV1[] {
  return [...track.clips].sort((left, right) =>
    left.startFrame - right.startFrame || compareStrings(left.id, right.id));
}

function issue(
  code: MltCompatibilityIssueCode,
  message: string,
  context: Omit<MltCompatibilityIssue, 'code' | 'message'> = {},
): MltCompatibilityIssue {
  return { code, message, ...context };
}

function resolvedResourceMap(
  resources: readonly ResolvedMltResource[],
  blockers: MltCompatibilityIssue[],
): Map<string, ResolvedMltResource> {
  const result = new Map<string, ResolvedMltResource>();
  for (const resource of [...resources].sort((left, right) =>
    compareStrings(left.uri, right.uri) || compareStrings(left.absolutePath, right.absolutePath))) {
    const existing = result.get(resource.uri);
    if (existing !== undefined) {
      blockers.push(issue('duplicate-resource', `Resource URI is resolved more than once: ${resource.uri}`, {
        uri: resource.uri,
      }));
      continue;
    }
    if (!resource.absolutePath || !isPortableAbsolutePath(resource.absolutePath)
      || containsInvalidXmlCharacter(resource.absolutePath)) {
      blockers.push(issue('invalid-resource-path', `Resolved resource path is not a safe absolute XML path: ${resource.uri}`, {
        uri: resource.uri,
      }));
      continue;
    }
    result.set(resource.uri, resource);
  }
  return result;
}

/** Report every semantic feature the first MLT XML backend cannot yet preserve. */
export function analyzeMltCompatibility(
  timeline: NeutralTimelineV1,
  resources: readonly ResolvedMltResource[],
): MltCompatibilityReport {
  const blockers: MltCompatibilityIssue[] = [];
  const warnings: MltCompatibilityIssue[] = [];
  const resourceMap = resolvedResourceMap(resources, blockers);
  const validationErrors = neutralTimelineV1Errors(timeline);
  for (const message of validationErrors) blockers.push(issue('invalid-timeline', message));
  if (validationErrors.length) return { compatible: false, blockers, warnings };

  const usedUris = new Set<string>();
  for (const diagnostic of timeline.diagnostics) {
    const context = {
      ...(diagnostic.trackId ? { trackId: diagnostic.trackId } : {}),
      ...(diagnostic.clipId ? { clipId: diagnostic.clipId } : {}),
      ...(diagnostic.transitionId ? { transitionId: diagnostic.transitionId } : {}),
    };
    if (diagnostic.code === 'unsupported-feature') {
      blockers.push(issue('upstream-unsupported-feature', diagnostic.message, context));
    } else if (diagnostic.severity === 'error') {
      blockers.push(issue('timeline-error', diagnostic.message, context));
    }
  }

  for (const track of sortedTracks(timeline)) {
    if (!track.enabled) continue;
    if (track.kind === 'caption') {
      if (track.clips.length) {
        blockers.push(issue(
          'clip-track-kind-mismatch',
          `Caption track ${track.id} contains media clips that the MLT backend would omit`,
          { trackId: track.id },
        ));
      }
      if (track.captions?.cues.length) {
        blockers.push(issue('caption-track', `Caption track ${track.id} is not supported by the MLT XML backend`, {
          trackId: track.id,
        }));
      }
      continue;
    }
    if (track.audioRouting !== undefined) blockers.push(issue(
      'audio-routing', `Track ${track.id} uses unsupported audio routing`, { trackId: track.id },
    ));

    let previous: NeutralClipV1 | undefined;
    for (const clip of sortedClips(track)) {
      const context = { trackId: track.id, clipId: clip.id };
      if (previous && clip.startFrame < previous.startFrame + previous.durationFrames) blockers.push(issue(
        'same-track-overlap', `Clip ${clip.id} overlaps ${previous.id} on track ${track.id}`, context,
      ));
      if (!previous || clip.startFrame + clip.durationFrames > previous.startFrame + previous.durationFrames) {
        previous = clip;
      }

      if (clip.placeholder) blockers.push(issue(
        'placeholder', `Clip ${clip.id} still requires backend rendering: ${clip.placeholder.reason}`, context,
      ));
      if (!SUPPORTED_CLIP_KINDS.has(clip.kind)) blockers.push(issue(
        'unsupported-clip-kind', `Clip kind ${clip.kind} is not supported by the MLT XML backend`, context,
      ));
      if ((track.kind === 'audio' && clip.kind !== 'audio')
        || (track.kind === 'video' && clip.kind === 'audio')) blockers.push(issue(
        'clip-track-kind-mismatch', `Clip ${clip.id} does not match ${track.kind} track ${track.id}`, context,
      ));
      if (!clip.source) {
        blockers.push(issue('missing-source', `Clip ${clip.id} has no media source`, context));
      } else {
        usedUris.add(clip.source.uri);
        if (!resourceMap.has(clip.source.uri)) blockers.push(issue(
          'missing-resolved-resource', `No resolved local resource exists for ${clip.source.uri}`, {
            ...context, uri: clip.source.uri,
          },
        ));
        if (clip.source.playbackRate !== 1) blockers.push(issue(
          'playback-rate', `Clip ${clip.id} uses playback rate ${clip.source.playbackRate}; only 1x is supported`, context,
        ));
        if (clip.source.segments !== undefined) blockers.push(issue(
          'source-segments', `Clip ${clip.id} uses edited source segments`, context,
        ));
        if (clip.source.alternateAudioUri !== undefined) {
          usedUris.add(clip.source.alternateAudioUri);
          blockers.push(issue('alternate-audio', `Clip ${clip.id} uses an alternate audio source`, context));
        }
        if (clip.kind === 'video' || clip.kind === 'image') {
          const resolved = resourceMap.get(clip.source.uri);
          if (resolved?.width === undefined || resolved.height === undefined) blockers.push(issue(
            'source-dimensions',
            `Clip ${clip.id} has no probed source dimensions; canvas fit=${timeline.canvas.fit} cannot be verified`,
            context,
          ));
          else if (resolved.width !== timeline.canvas.width || resolved.height !== timeline.canvas.height) {
            blockers.push(issue(
              'canvas-fit',
              `Clip ${clip.id} probes as ${resolved.width}x${resolved.height}, but the canvas is ${timeline.canvas.width}x${timeline.canvas.height}; fit=${timeline.canvas.fit} is not implemented by the experimental MLT backend`,
              context,
            ));
          }
        }
      }
      if (clip.visual !== undefined) blockers.push(issue(
        'visual-adjustment', `Clip ${clip.id} uses visual adjustments`, context,
      ));
      if (clip.keyframes !== undefined) blockers.push(issue(
        'keyframes', `Clip ${clip.id} uses keyframes`, context,
      ));
      if (clip.audio && (clip.audio.volume !== 1
        || clip.audio.fadeInFrames !== undefined || clip.audio.fadeOutFrames !== undefined)) blockers.push(issue(
        'audio-adjustment', `Clip ${clip.id} uses audio gain or fades`, context,
      ));
    }
  }

  for (const transition of timeline.transitions) {
    if (!transition.enabled) continue;
    const context = { trackId: transition.trackId, transitionId: transition.id };
    blockers.push(issue(
      transition.custom ? 'custom-transition' : 'unsupported-transition',
      `Clip transition ${transition.id} (${transition.type}) is not supported by the MLT XML backend`,
      context,
    ));
  }

  for (const uri of [...resourceMap.keys()].sort()) {
    if (!usedUris.has(uri)) warnings.push(issue('unused-resource', `Resolved resource is not used: ${uri}`, { uri }));
  }
  return { compatible: blockers.length === 0, blockers, warnings };
}

function property(name: string, value: string | number): string {
  return `    <property name="${escapeXml(name)}">${escapeXml(String(value))}</property>`;
}

function producerXml(clip: NeutralClipV1, producerId: string, absolutePath: string): string {
  const lines = [
    `  <producer id="${producerId}">`,
    property('mlt_service', 'avformat'),
    property('resource', absolutePath),
  ];
  if (clip.kind === 'image') lines.push(property('eof', 'pause'));
  lines.push('  </producer>');
  return lines.join('\n');
}

function playlistXml(
  track: NeutralTrackV1,
  playlistId: string,
  producerIds: ReadonlyMap<string, string>,
  durationFrames: number,
): string {
  const lines = [
    `  <playlist id="${playlistId}">`,
  ];
  let cursor = 0;
  for (const clip of sortedClips(track)) {
    if (clip.startFrame > cursor) lines.push(`    <blank length="${clip.startFrame - cursor}"/>`);
    const sourceIn = clip.source!.sourceInFrame;
    lines.push(`    <entry producer="${producerIds.get(clip.id)!}" in="${sourceIn}" out="${sourceIn + clip.durationFrames - 1}"/>`);
    cursor = clip.startFrame + clip.durationFrames;
  }
  if (cursor < durationFrames) lines.push(`    <blank length="${durationFrames - cursor}"/>`);
  lines.push('  </playlist>');
  return lines.join('\n');
}

function gcd(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b) [a, b] = [b, a % b];
  return a;
}

/** Convert a compatible NeutralTimelineV1 into deterministic MLT XML. */
export function convertNeutralTimelineToMltXml(
  timeline: NeutralTimelineV1,
  resources: readonly ResolvedMltResource[],
  options: { cpuThreads?: number } = {},
): MltXmlResult {
  const compatibility = analyzeMltCompatibility(timeline, resources);
  if (!compatibility.compatible) throw new MltCompatibilityError(compatibility);

  const resourceMap = new Map(resources.map((resource) => [resource.uri, resource.absolutePath]));
  const cpuThreads = options.cpuThreads;
  if (cpuThreads !== undefined && (!Number.isInteger(cpuThreads) || cpuThreads < 1 || cpuThreads > 16)) {
    throw new Error('MLT XML cpuThreads must be an integer from 1 to 16');
  }
  const tracks = sortedTracks(timeline).filter((track) => track.enabled && track.kind !== 'caption');
  const producerIds = new Map<string, string>();
  let producerIndex = 0;
  for (const track of tracks) {
    for (const clip of sortedClips(track)) producerIds.set(clip.id, `producer_${String(producerIndex++).padStart(4, '0')}`);
  }
  const playlistIds = new Map(tracks.map((track, index) => [track.id, `playlist_${String(index).padStart(4, '0')}`]));
  const aspectDivisor = gcd(timeline.canvas.width, timeline.canvas.height);
  const lastFrame = timeline.durationFrames - 1;
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<mlt LC_NUMERIC="C" producer="main_tractor">',
    `  <profile description="CutAI NeutralTimelineV1" width="${timeline.canvas.width}" height="${timeline.canvas.height}" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="${timeline.canvas.width / aspectDivisor}" display_aspect_den="${timeline.canvas.height / aspectDivisor}" frame_rate_num="${timeline.frameRate.numerator}" frame_rate_den="${timeline.frameRate.denominator}" colorspace="709"/>`,
    '  <producer id="background">',
    property('mlt_service', 'color'),
    property('resource', 'black'),
    property('length', timeline.durationFrames),
    '  </producer>',
  ];
  for (const track of tracks) {
    for (const clip of sortedClips(track)) {
      const producer = producerXml(
        clip,
        producerIds.get(clip.id)!,
        resourceMap.get(clip.source!.uri)!,
      );
      lines.push(cpuThreads === undefined
        ? producer
        : producer.replace('  </producer>', `${property('threads', 1)}\n  </producer>`));
    }
  }
  lines.push(
    '  <playlist id="background_playlist">',
    `    <entry producer="background" in="0" out="${lastFrame}"/>`,
    '  </playlist>',
  );
  for (const track of tracks) lines.push(playlistXml(
    track, playlistIds.get(track.id)!, producerIds, timeline.durationFrames,
  ));

  const bottomToTop = [...tracks].reverse();
  lines.push(
    `  <tractor id="main_tractor" in="0" out="${lastFrame}">`,
    '    <multitrack id="main_multitrack">',
    '      <track producer="background_playlist"/>',
  );
  for (const track of bottomToTop) {
    const hiddenAudio = track.muted ? ' hide="audio"' : '';
    lines.push(`      <track producer="${playlistIds.get(track.id)!}"${hiddenAudio}/>`);
  }
  lines.push('    </multitrack>');
  for (const [index, track] of bottomToTop.entries()) {
    const mltTrack = index + 1;
    if (track.kind === 'video') lines.push(
      `    <transition id="qtblend_${String(index).padStart(4, '0')}">`,
      property('a_track', 0),
      property('b_track', mltTrack),
      property('always_active', 1),
      property('mlt_service', 'qtblend'),
      '    </transition>',
    );
    lines.push(
      `    <transition id="mix_${String(index).padStart(4, '0')}">`,
      property('a_track', 0),
      property('b_track', mltTrack),
      property('always_active', 1),
      property('sum', 1),
      property('mlt_service', 'mix'),
      '    </transition>',
    );
  }
  lines.push('  </tractor>', '</mlt>', '');
  return { xml: lines.join('\n'), compatibility };
}
