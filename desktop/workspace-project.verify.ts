import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkspaceProject,
  openWorkspaceProject,
  rescanWorkspace,
  saveWorkspaceProject,
} from './workspace-project.ts';

interface TestDoc {
  version: number;
  tracks: unknown[];
}

const valid = (value: unknown): value is TestDoc => !!value
  && typeof value === 'object'
  && (value as { version?: unknown }).version === 1
  && Array.isArray((value as { tracks?: unknown }).tracks);

const base = await mkdtemp(join(tmpdir(), 'cutai-workspace-'));
const root = join(base, '中文 长路径 local workspace');
await mkdir(join(root, '素材 子目录'), { recursive: true });
await mkdir(join(root, '.git'), { recursive: true });
await mkdir(join(root, 'node_modules'), { recursive: true });
await writeFile(join(root, '素材 子目录', '封面 图片.png'), 'png bytes', 'utf8');
await writeFile(join(root, '.git', 'ignored.mp4'), 'ignored', 'utf8');
await writeFile(join(root, 'node_modules', 'ignored.wav'), 'ignored', 'utf8');

const outside = join(base, 'outside');
await mkdir(outside, { recursive: true });
await writeFile(join(outside, 'escape.mp4'), 'outside', 'utf8');
try {
  await symlink(outside, join(root, 'linked-outside'), 'junction');
} catch {
  // Creating junctions can be unavailable on restricted Windows accounts.
}

const created = await createWorkspaceProject(root, { version: 1, tracks: [] }, 'test', 'workspace-test-id');
assert.equal(created.manifest.schemaVersion, 2);
assert.equal(created.media.length, 1);
assert.match(created.media[0]?.relativePath ?? '', /封面 图片\.png$/);
for (const directory of ['autosave', 'audit', 'sessions']) {
  assert.equal((await stat(join(root, '.cutai', directory))).isDirectory(), true);
}

await saveWorkspaceProject(root, { version: 1, tracks: ['saved'] }, 'test-2', valid);
await saveWorkspaceProject(root, { version: 1, tracks: ['saved-again'] }, 'test-3', valid);
assert.deepEqual(
  JSON.parse(await readFile(join(root, '.cutai', 'project.json.bak'), 'utf8')),
  { version: 1, tracks: ['saved'] },
);

await writeFile(join(root, '新增 音频.mp3'), 'audio bytes', 'utf8');
const rescanned = await rescanWorkspace(root);
assert.equal(rescanned.length, 2);
assert.equal(rescanned.some((item) => item.name === '新增 音频.mp3'), true);
assert.equal(rescanned.some((item) => item.name === 'escape.mp4'), false);

const reopened = await openWorkspaceProject(root, valid);
assert.deepEqual(reopened.document, { version: 1, tracks: ['saved-again'] });
assert.equal(reopened.rootPath, root);
console.log('workspace-project.verify: ok');
