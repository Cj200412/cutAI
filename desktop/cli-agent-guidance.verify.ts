import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCutaiAgentGuides } from './cli-agent-guidance.ts';

const root = await mkdtemp(join(tmpdir(), 'cutai-agent-guides-'));
try {
  const directory = await ensureCutaiAgentGuides(root);
  const readme = await readFile(join(directory, 'README.md'), 'utf8');
  const projectFormat = await readFile(join(directory, 'project-format.md'), 'utf8');
  const motionGraphics = await readFile(join(directory, 'motion-graphics.md'), 'utf8');

  assert.match(readme, /每次任务的最短路径/);
  assert.match(projectFormat, /"version": 3/);
  assert.match(projectFormat, /activeTimelineId/);
  assert.match(motionGraphics, /useCurrentFrame/);
  assert.match(motionGraphics, /不写 import、require、export/);

  await ensureCutaiAgentGuides(root);
  assert.equal(await readFile(join(directory, 'README.md'), 'utf8'), readme);
  console.log('cli-agent-guidance.verify: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
