export interface LocalWhisperChunk {
  text?: string;
  timestamp?: [number | null, number | null];
}

export interface LocalWhisperWindowOutput {
  text?: string;
  chunks?: LocalWhisperChunk[];
}

export interface AcceptedWhisperWindow {
  text: string;
  chunks: LocalWhisperChunk[];
  durationSeconds: number;
  punctuationBoundary: boolean;
}

const PUNCTUATION_BOUNDARY = /[。！？；：，、.!?;:…]+(?:["'”’）)】』」》〉〕]*)/g;
const TRAILING_PUNCTUATION = /[。！？；：，、.!?;:…]+(?:["'”’）)】』」》〉〕]*)$/;

function lastPunctuationEnd(text: string): number | null {
  let result: number | null = null;
  for (const match of text.matchAll(PUNCTUATION_BOUNDARY)) {
    result = (match.index ?? 0) + match[0].length;
  }
  return result;
}

/**
 * Validate one adaptive Whisper window and select a time-aligned punctuation
 * boundary. Non-empty text without timestamps is rejected instead of being
 * silently reported as a successful empty transcript.
 */
export function acceptWhisperWindow(
  output: LocalWhisperWindowOutput,
  windowSeconds: number,
  finalizeOpenEnded = false,
): AcceptedWhisperWindow {
  const window = Math.max(0, Number(windowSeconds) || 0);
  const sourceText = (output.text ?? '').trim();
  let hasOpenEndedChunk = false;
  const chunks = (output.chunks ?? []).flatMap((chunk) => {
    const text = (chunk.text ?? '').trim();
    if (!text) return [];
    const start = chunk.timestamp?.[0];
    const rawEnd = chunk.timestamp?.[1];
    if (typeof start !== 'number' || !Number.isFinite(start)) {
      throw new Error('本地模型返回了文字但缺少分段时间戳，请更换 Whisper 模型后重试');
    }
    if (rawEnd === null) {
      hasOpenEndedChunk = true;
      if (!finalizeOpenEnded) return [];
    } else if (typeof rawEnd !== 'number' || !Number.isFinite(rawEnd)) {
      throw new Error('本地模型返回了文字但缺少分段时间戳，请更换 Whisper 模型后重试');
    }
    const end = rawEnd === null ? window : rawEnd;
    const boundedStart = Math.max(0, Math.min(window, start));
    const boundedEnd = Math.max(boundedStart, Math.min(window, end));
    if (boundedEnd <= boundedStart) {
      throw new Error('本地模型返回了无效的分段时间戳，请更换 Whisper 模型后重试');
    }
    return [{ text, timestamp: [boundedStart, boundedEnd] as [number, number] }];
  });

  if (!chunks.length) {
    // Transformers.js commonly returns [start, null] for a phrase cut by the
    // current window. It is a request for more context, not a corrupt result.
    if (hasOpenEndedChunk && !finalizeOpenEnded) {
      return { text: '', chunks: [], durationSeconds: window, punctuationBoundary: false };
    }
    if (sourceText) throw new Error('本地模型返回了文字但缺少分段时间戳，请更换 Whisper 模型后重试');
    return { text: '', chunks: [], durationSeconds: window, punctuationBoundary: false };
  }

  // Some model variants put the final punctuation only in `output.text`.
  // Attach that suffix to the final timed chunk so generated captions retain it.
  const suffix = sourceText.match(TRAILING_PUNCTUATION)?.[0] ?? '';
  const tail = chunks[chunks.length - 1]!;
  if (suffix && (!hasOpenEndedChunk || finalizeOpenEnded) && !TRAILING_PUNCTUATION.test(tail.text ?? '')) {
    tail.text = `${tail.text}${suffix}`;
  }

  let boundaryChunkIndex = -1;
  let boundaryTextEnd = -1;
  for (let index = 0; index < chunks.length; index += 1) {
    const punctuationEnd = lastPunctuationEnd(chunks[index]!.text ?? '');
    if (punctuationEnd !== null) {
      boundaryChunkIndex = index;
      boundaryTextEnd = punctuationEnd;
    }
  }

  if (boundaryChunkIndex < 0) {
    return {
      text: chunks.map((chunk) => chunk.text ?? '').join(''),
      chunks,
      durationSeconds: window,
      punctuationBoundary: false,
    };
  }

  const boundaryChunk = chunks[boundaryChunkIndex]!;
  const [chunkStart, chunkEnd] = boundaryChunk.timestamp as [number, number];
  const chunkText = boundaryChunk.text ?? '';
  const boundaryTime = chunkStart + (chunkEnd - chunkStart) * boundaryTextEnd / Math.max(1, chunkText.length);
  if (boundaryTime < 0.25) {
    return {
      text: chunks.map((chunk) => chunk.text ?? '').join(''),
      chunks,
      durationSeconds: window,
      punctuationBoundary: false,
    };
  }

  const accepted = chunks.slice(0, boundaryChunkIndex + 1);
  accepted[accepted.length - 1] = {
    text: chunkText.slice(0, boundaryTextEnd),
    timestamp: [chunkStart, boundaryTime],
  };
  return {
    text: accepted.map((chunk) => chunk.text ?? '').join(''),
    chunks: accepted,
    durationSeconds: boundaryTime,
    punctuationBoundary: true,
  };
}
