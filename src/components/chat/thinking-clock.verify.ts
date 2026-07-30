import assert from 'node:assert/strict';
import type { DisplayMessage } from '../../agent/useAgent';
import { pauseThinkingClock, startThinkingClock } from './thinking-clock.ts';

const base: DisplayMessage = { role: 'assistant', text: '', thinking: 'reasoning' };
const started = startThinkingClock(base, 1_000);
assert.equal(started.thinkingActive, true);
assert.equal(started.thinkingStartedAt, 1_000);

const pausedForTool = pauseThinkingClock(started, 2_500);
assert.equal(pausedForTool.thinkingActive, false);
assert.equal(pausedForTool.thinkingElapsedMs, 1_500);

const resumed = startThinkingClock(pausedForTool, 8_000);
const completed = pauseThinkingClock(resumed, 9_250);
assert.equal(completed.thinkingElapsedMs, 2_750, 'tool wait time must not count as thinking');
assert.equal(completed.thinkingStartedAt, undefined);

console.log('thinking-clock.verify: ok');
