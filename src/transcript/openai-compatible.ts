import type { TranscriptResult, TranscriptWord } from './types';

interface CompatibleWord {
  word?: unknown;
  text?: unknown;
  start?: unknown;
  end?: unknown;
}

interface CompatibleSegment {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  words?: CompatibleWord[];
}

interface CompatibleResponse {
  text?: unknown;
  words?: CompatibleWord[];
  segments?: CompatibleSegment[];
}

function textTokens(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (/\s/.test(trimmed)) return trimmed.split(/\s+/).filter(Boolean);
  return Array.from(trimmed);
}

function numericTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value * 1000)) : null;
}

function mappedWords(rows: CompatibleWord[] | undefined): TranscriptWord[] {
  return (rows ?? []).flatMap((row) => {
    const text = typeof row.word === 'string' ? row.word.trim() : typeof row.text === 'string' ? row.text.trim() : '';
    const start = numericTime(row.start);
    const end = numericTime(row.end);
    return text && start != null && end != null ? [{ text, start, end, speaker: null }] : [];
  });
}

function wordsFromSegment(segment: CompatibleSegment): TranscriptWord[] {
  const direct = mappedWords(segment.words);
  if (direct.length) return direct;
  const text = typeof segment.text === 'string' ? segment.text : '';
  const start = numericTime(segment.start);
  const end = numericTime(segment.end);
  const tokens = textTokens(text);
  if (start == null || end == null || !tokens.length) return [];
  const span = Math.max(tokens.length, end - start);
  return tokens.map((token, index) => ({
    text: token,
    start: Math.round(start + span * index / tokens.length),
    end: Math.round(start + span * (index + 1) / tokens.length),
    speaker: null,
  }));
}

export function compatibleTranscriptResult(body: CompatibleResponse): TranscriptResult {
  let words = mappedWords(body.words);
  if (!words.length) words = (body.segments ?? []).flatMap(wordsFromSegment);
  if (!words.length) {
    throw new Error('自定义转写服务未返回词级或分段时间戳；请启用 verbose_json 时间戳输出');
  }
  const text = typeof body.text === 'string' && body.text.trim()
    ? body.text
    : words.map((word) => word.text).join('');
  return { text, words, utterances: [] };
}

export async function transcribeCompatibleBlob(
  blob: Blob,
  model: string,
  languageCode: string | 'auto',
  onWait?: () => void,
): Promise<TranscriptResult> {
  const form = new FormData();
  form.append('file', blob, 'cutai-transcription.wav');
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  if (languageCode !== 'auto') form.append('language', languageCode);
  onWait?.();
  const response = await fetch('/transcription-compatible/audio/transcriptions', {
    method: 'POST',
    body: form,
  });
  const body = await response.json().catch(() => null) as CompatibleResponse | { error?: unknown } | null;
  if (!response.ok) {
    const detail = body && typeof body === 'object' && 'error' in body ? JSON.stringify(body.error) : '';
    throw new Error(`custom transcription failed: HTTP ${response.status}${detail ? ` · ${detail}` : ''}`);
  }
  if (!body || typeof body !== 'object') throw new Error('自定义转写服务返回了无效响应');
  return compatibleTranscriptResult(body as CompatibleResponse);
}
