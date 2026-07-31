import assert from 'node:assert/strict';
import { paginate } from './types';
import type { TranscriptWord } from '../transcript/types';

const words: TranscriptWord[] = Array.from({ length: 8 }, (_, i) => ({
  text: `词${i + 1}`,
  start: i * 900,
  end: i * 900 + 400,
}));
const pages = paginate(words, 'phrase', 20);
assert.ok(pages.length >= 2, 'long phrase must split by elapsed time');
assert.ok(pages.every((page) => page.end - page.start <= 4_000), 'caption pages stay within time window');
console.log('captions.types.check: ok');
