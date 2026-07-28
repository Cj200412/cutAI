import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCutaiAudit, cutaiProjectDisplayName, loadCutaiProject,
  registerCutaiMedia, relinkCutaiMedia, saveCutaiProject, verifyCutaiMedia, writeCutaiAutosave,
} from './cutai-project.ts';

const root = join(await mkdtemp(join(tmpdir(), 'cutai-project-')), '中文 工程.cutai');
const valid = (value: unknown): value is { version: number; tracks: unknown[] } => !!value
  && typeof value === 'object' && (value as { version?: unknown }).version === 1
  && Array.isArray((value as { tracks?: unknown }).tracks);

const first = await saveCutaiProject({ directory: root, document: { version: 1, tracks: [] }, appVersion: '0.1.0', validate: valid });
assert.equal(first.schemaVersion, 1);
assert.equal(cutaiProjectDisplayName(root), '中文 工程');
const loaded = await loadCutaiProject(root, valid);
assert.deepEqual(loaded.document, { version: 1, tracks: [] });
await writeCutaiAutosave(root, { version: 1, tracks: ['a'] }, valid);
await appendCutaiAudit(root, { action: 'test-save' });
const sourceDir = await mkdtemp(join(tmpdir(), 'cutai-source-'));
const source = join(sourceDir, '素材 文件.txt');
await writeFile(source, 'stable media bytes', 'utf8');
await registerCutaiMedia({ directory: root, assetId: 'asset-1', sourcePath: source, mode: 'copy' });
assert.equal((await verifyCutaiMedia(root))[0]?.status, 'available');
await writeFile(source, 'changed source bytes', 'utf8');
assert.equal((await verifyCutaiMedia(root))[0]?.status, 'available', 'copy mode must not depend on a changed source');
const reference = await registerCutaiMedia({ directory: root, assetId: 'asset-2', sourcePath: join(root, 'media', 'asset-1-素材 文件.txt'), mode: 'reference' });
await mkdir(join(sourceDir, 'nested'), { recursive: true });
const moved = join(sourceDir, 'nested', 'relocated.txt');
await writeFile(moved, 'stable media bytes', 'utf8');
await writeFile(reference.sourcePath, 'mutated copied media', 'utf8');
assert.equal((await verifyCutaiMedia(root)).find((entry) => entry.assetId === 'asset-2')?.status, 'changed');
assert.equal((await relinkCutaiMedia(root, 'asset-2', sourceDir))?.sourcePath, moved);
assert.equal((await verifyCutaiMedia(root)).find((entry) => entry.assetId === 'asset-2')?.status, 'available');
await saveCutaiProject({ directory: root, document: { version: 1, tracks: ['a'] }, appVersion: '0.1.1', validate: valid });
assert.deepEqual((await loadCutaiProject(root, valid)).document, { version: 1, tracks: ['a'] });
assert.match(await readFile(join(root, 'audit', 'events.ndjson'), 'utf8'), /test-save/);
await writeFile(join(root, 'manifest.json'), '{bad json', 'utf8');
await assert.rejects(() => loadCutaiProject(root, valid));
assert.deepEqual(JSON.parse(await readFile(join(root, 'project.json.bak'), 'utf8')), { version: 1, tracks: [] });
console.log('cutai-project.verify: ok');
