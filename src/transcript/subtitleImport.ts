import type { TranscriptWord } from './types';

interface Cue { start: number; end: number; text: string }

function timeMs(value: string): number | null {
  const parts = value.trim().replace(',', '.').split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || (parts.length !== 2 && parts.length !== 3)) return null;
  const [hours, minutes, seconds] = parts.length === 2 ? [0, parts[0]!, parts[1]!] : parts as [number, number, number];
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

function cleanText(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n').replace(/\s+/g, ' ').trim();
}

function parseSrtVtt(source: string): Cue[] {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const cues: Cue[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i]?.match(/(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[,.]\d{3})/);
    if (!match) continue;
    const start = timeMs(match[1]!); const end = timeMs(match[2]!);
    if (start == null || end == null || end <= start) continue;
    const text: string[] = [];
    for (i += 1; i < lines.length && lines[i]?.trim(); i += 1) text.push(lines[i]!);
    const cleaned = cleanText(text.join(' '));
    if (cleaned) cues.push({ start, end, text: cleaned });
  }
  return cues;
}

function parseAss(source: string): Cue[] {
  const assMs = (value: string): number | null => {
    const match = /^(\d+):(\d{2}):(\d{2})\.(\d{2})$/.exec(value.trim());
    if (!match) return null;
    return (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 + Number(match[4]) * 10;
  };
  const cues: Cue[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!/^Dialogue\s*:/i.test(line)) continue;
    const fields = line.slice(line.indexOf(':') + 1).split(',', 10);
    const start = assMs(fields[1] ?? '');
    const end = assMs(fields[2] ?? '');
    const text = cleanText(fields.slice(8).join(','));
    if (start != null && end != null && end > start && text) cues.push({ start, end, text });
  }
  return cues;
}

export function parseSubtitle(source: string, extension: string): TranscriptWord[] {
  const cues = extension.toLowerCase() === '.ass' ? parseAss(source) : parseSrtVtt(source);
  return cues.flatMap((cue) => {
    const tokens = /\s/.test(cue.text) ? cue.text.split(/\s+/).filter(Boolean) : Array.from(cue.text);
    const weights = tokens.map((token) => Math.max(1, token.length));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let offset = cue.start;
    return tokens.map((token, index) => {
      const end = index === tokens.length - 1 ? cue.end : offset + Math.max(1, Math.round((cue.end - cue.start) * weights[index]! / total));
      const word = { text: token, start: offset, end, speaker: null };
      offset = end;
      return word;
    });
  });
}

export function stemOf(name: string): string {
  return name.replace(/\.[^.]+$/, '').toLocaleLowerCase().replace(/[\s._-]+/g, '');
}
