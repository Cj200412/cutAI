import assert from 'node:assert/strict';
import { hasToolResultError } from './tool-result';

assert.equal(hasToolResultError(undefined), false);
assert.equal(hasToolResultError('.cutai/project.json'), false);
assert.equal(hasToolResultError(['.cutai/project.json']), false);
assert.equal(hasToolResultError({ status: 'completed' }), false);
assert.equal(hasToolResultError({ error: 'failed' }), true);

console.log('tool-result.verify: ok');
