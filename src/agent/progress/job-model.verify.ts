import assert from 'node:assert/strict';
import { isFailed, isTerminal, normalizeStatus } from './job-model.ts';

for (const status of ['cancelled', 'canceled']) {
  assert.equal(normalizeStatus(status), 'failed');
  assert.equal(isTerminal(status), true, `${status} must stop Agent polling`);
  assert.equal(isFailed(status), true, `${status} must be reported as an unsuccessful terminal state`);
}

console.log('job model cancellation checks passed');
