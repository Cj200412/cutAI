import assert from 'node:assert/strict';
import { ffmpegOutputThreadArgs, ffmpegThreadArgs } from './performance-budget.ts';
import { TaskLimiter } from './task-limiter.ts';

const inputThreadArgs = ffmpegThreadArgs();
const outputThreadArgs = ffmpegOutputThreadArgs();
assert.deepEqual(inputThreadArgs.slice(0, 4), [
  '-filter_threads', inputThreadArgs[1], '-filter_complex_threads', inputThreadArgs[1],
]);
assert.deepEqual(inputThreadArgs.slice(-2), ['-threads', inputThreadArgs[1]]);
assert.deepEqual(outputThreadArgs, ['-threads', inputThreadArgs[1]]);
assert.ok(Number(inputThreadArgs[1]) >= 1, 'FFmpeg thread budget must be a positive integer');

const limiter = new TaskLimiter(1);
const first = await limiter.acquire();
let secondStarted = false;
const secondPromise = limiter.acquire().then((release) => {
  secondStarted = true;
  return release;
});
await Promise.resolve();
assert.equal(secondStarted, false);
assert.deepEqual(limiter.snapshot(), { active: 1, queued: 1, limit: 1 });

limiter.setLimit(2);
const second = await secondPromise;
assert.equal(secondStarted, true);
assert.deepEqual(limiter.snapshot(), { active: 2, queued: 0, limit: 2 });

// A lower live limit never cancels active work and only gates the next start.
limiter.setLimit(1);
let thirdStarted = false;
const thirdPromise = limiter.acquire().then((release) => {
  thirdStarted = true;
  return release;
});
first();
await Promise.resolve();
assert.equal(thirdStarted, false);
second();
const third = await thirdPromise;
assert.equal(thirdStarted, true);
third();
assert.deepEqual(limiter.snapshot(), { active: 0, queued: 0, limit: 1 });

assert.throws(() => limiter.setLimit(0), /positive integer/);
console.log('task-limiter.verify: ok');
