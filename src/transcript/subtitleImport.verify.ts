import assert from 'node:assert/strict';
import { parseSubtitle, stemOf } from './subtitleImport.ts';

const words = parseSubtitle('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n你好 世界', '.vtt');
assert.deepEqual(words.map((word) => word.text), ['你好', '世界']);
assert.deepEqual(words.map((word) => [word.start, word.end]), [[1000, 2000], [2000, 3000]]);
const ass = parseSubtitle('Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,你好\\N世界', '.ass');
assert.equal(ass.length, 2);
assert.equal(stemOf('7月26日.mp4'), stemOf('7月26日.srt'));
console.log('subtitle import checks passed');
