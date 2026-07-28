import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const CUTAI_PROJECT_SCHEMA_VERSION = 1;
const MANIFEST_FILE = 'manifest.json';
const PROJECT_FILE = 'project.json';
const MEDIA_INDEX_FILE = 'media-index.json';

export interface CutaiManifest {
  format: 'cutai-project';
  schemaVersion: typeof CUTAI_PROJECT_SCHEMA_VERSION;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  appVersion: string;
  migrations: string[];
}

export interface CutaiProject<T> {
  manifest: CutaiManifest;
  document: T;
}

export type CutaiMediaMode = 'reference' | 'copy';

export interface CutaiMediaEntry {
  assetId: string;
  name: string;
  mode: CutaiMediaMode;
  sourcePath: string;
  relativePath?: string;
  bytes: number;
  modifiedAtMs: number;
  sha256: string;
}

export interface RegisterCutaiMediaOptions {
  directory: string;
  assetId: string;
  sourcePath: string;
  mode: CutaiMediaMode;
}

export interface SaveCutaiProjectOptions<T> {
  directory: string;
  document: T;
  appVersion: string;
  validate: (value: unknown) => value is T;
  migrationNote?: string;
  projectId?: string;
}

function projectRoot(directory: string): string {
  const root = resolve(directory);
  if (extname(root).toLowerCase() !== '.cutai') {
    throw new Error('CutAI project directory must end with .cutai');
  }
  return root;
}

function isManifest(value: unknown): value is CutaiManifest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<CutaiManifest>;
  return v.format === 'cutai-project'
    && v.schemaVersion === CUTAI_PROJECT_SCHEMA_VERSION
    && typeof v.projectId === 'string' && v.projectId.length > 0
    && typeof v.createdAt === 'string' && typeof v.updatedAt === 'string'
    && typeof v.appVersion === 'string' && Array.isArray(v.migrations)
    && v.migrations.every((entry) => typeof entry === 'string');
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function isMediaEntry(value: unknown): value is CutaiMediaEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<CutaiMediaEntry>;
  return typeof v.assetId === 'string' && !!v.assetId
    && typeof v.name === 'string' && !!v.name
    && (v.mode === 'reference' || v.mode === 'copy')
    && typeof v.sourcePath === 'string' && isAbsolute(v.sourcePath)
    && (v.relativePath === undefined || typeof v.relativePath === 'string')
    && typeof v.bytes === 'number' && v.bytes >= 0
    && typeof v.modifiedAtMs === 'number' && v.modifiedAtMs >= 0
    && typeof v.sha256 === 'string' && /^[a-f0-9]{64}$/.test(v.sha256);
}

export async function sha256File(path: string): Promise<string> {
  return new Promise((resolveDigest, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveDigest(digest.digest('hex')));
  });
}

async function loadMediaIndex(root: string): Promise<CutaiMediaEntry[]> {
  try {
    const raw = await readJson(join(root, MEDIA_INDEX_FILE));
    return Array.isArray(raw) ? raw.filter(isMediaEntry) : [];
  } catch {
    return [];
  }
}

function mediaFileName(assetId: string, name: string): string {
  const safeAsset = assetId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'asset';
  const safeName = basename(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 160) || 'media';
  return `${safeAsset}-${safeName}`;
}

/** Register a source file without ever editing/deleting it. Copy mode keeps a project-local media file. */
export async function registerCutaiMedia(options: RegisterCutaiMediaOptions): Promise<CutaiMediaEntry> {
  const root = projectRoot(options.directory);
  if (!options.assetId || !isAbsolute(options.sourcePath)) throw new Error('Media asset id and absolute source path are required');
  const source = resolve(options.sourcePath);
  const info = await stat(source);
  if (!info.isFile()) throw new Error('Media source is not a file');
  await mkdir(join(root, 'media'), { recursive: true });
  const sha256 = await sha256File(source);
  const entry: CutaiMediaEntry = {
    assetId: options.assetId,
    name: basename(source),
    mode: options.mode,
    sourcePath: source,
    bytes: info.size,
    modifiedAtMs: info.mtimeMs,
    sha256,
  };
  if (options.mode === 'copy') {
    const target = join(root, 'media', mediaFileName(options.assetId, entry.name));
    await copyFile(source, target);
    entry.relativePath = relative(root, target);
  }
  const index = (await loadMediaIndex(root)).filter((current) => current.assetId !== entry.assetId);
  index.push(entry);
  await writeJsonAtomically(join(root, MEDIA_INDEX_FILE), index);
  return entry;
}

export async function verifyCutaiMedia(directory: string): Promise<Array<CutaiMediaEntry & { status: 'available' | 'missing' | 'changed' }>> {
  const root = projectRoot(directory);
  const index = await loadMediaIndex(root);
  return Promise.all(index.map(async (entry) => {
    const candidate = entry.mode === 'copy' && entry.relativePath ? join(root, entry.relativePath) : entry.sourcePath;
    try {
      const info = await stat(candidate);
      if (!info.isFile()) return { ...entry, status: 'missing' as const };
      return { ...entry, status: (await sha256File(candidate)) === entry.sha256 ? 'available' as const : 'changed' as const };
    } catch {
      return { ...entry, status: 'missing' as const };
    }
  }));
}

/** Search a user-selected directory tree for a file with the exact stored digest, then update only the reference. */
export async function relinkCutaiMedia(directory: string, assetId: string, searchDirectory: string): Promise<CutaiMediaEntry | null> {
  const root = projectRoot(directory);
  const index = await loadMediaIndex(root);
  const current = index.find((entry) => entry.assetId === assetId);
  if (!current || !isAbsolute(searchDirectory)) return null;
  const queue = [resolve(searchDirectory)];
  while (queue.length) {
    const next = queue.shift()!;
    const entries = await readdir(next, { withFileTypes: true });
    for (const child of entries) {
      const path = join(next, child.name);
      if (child.isDirectory()) { queue.push(path); continue; }
      if (!child.isFile()) continue;
      const info = await stat(path);
      if (info.size !== current.bytes || (await sha256File(path)) !== current.sha256) continue;
      const replacement: CutaiMediaEntry = { ...current, sourcePath: path, name: child.name, modifiedAtMs: info.mtimeMs };
      await writeJsonAtomically(join(root, MEDIA_INDEX_FILE), index.map((entry) => entry.assetId === assetId ? replacement : entry));
      return replacement;
    }
  }
  return null;
}

/**
 * Save a directory-format `.cutai` project. Existing manifest/project files are
 * copied to `.bak` before replacement, so a failed or incompatible migration
 * never silently destroys the last readable state.
 */
export async function saveCutaiProject<T>(options: SaveCutaiProjectOptions<T>): Promise<CutaiManifest> {
  if (!options.validate(options.document)) throw new Error('Project document failed validation');
  const root = projectRoot(options.directory);
  const manifestPath = join(root, MANIFEST_FILE);
  const documentPath = join(root, PROJECT_FILE);
  await mkdir(join(root, 'autosave'), { recursive: true });
  await mkdir(join(root, 'audit'), { recursive: true });
  const now = new Date().toISOString();
  let previous: CutaiManifest | undefined;
  try {
    const raw = await readJson(manifestPath);
    if (isManifest(raw)) previous = raw;
  } catch {
    // New project or a damaged manifest: preserve any surviving files below.
  }
  if (previous) {
    await copyFile(manifestPath, `${manifestPath}.bak`);
    await copyFile(documentPath, `${documentPath}.bak`);
  }
  const manifest: CutaiManifest = {
    format: 'cutai-project',
    schemaVersion: CUTAI_PROJECT_SCHEMA_VERSION,
    projectId: previous?.projectId ?? options.projectId ?? randomUUID(),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    appVersion: options.appVersion,
    migrations: [...(previous?.migrations ?? []), ...(options.migrationNote ? [options.migrationNote] : [])],
  };
  await writeJsonAtomically(documentPath, options.document);
  await writeJsonAtomically(manifestPath, manifest);
  return manifest;
}

/** Read only; malformed or future project metadata is rejected without writes. */
export async function loadCutaiProject<T>(directory: string, validate: (value: unknown) => value is T): Promise<CutaiProject<T>> {
  const root = projectRoot(directory);
  const manifest = await readJson(join(root, MANIFEST_FILE));
  if (!isManifest(manifest)) throw new Error('Invalid or unsupported CutAI manifest');
  const document = await readJson(join(root, PROJECT_FILE));
  if (!validate(document)) throw new Error('CutAI project document failed validation');
  return { manifest, document };
}

/** Snapshot data separately from the primary project; callers choose retention. */
export async function writeCutaiAutosave<T>(directory: string, document: T, validate: (value: unknown) => value is T): Promise<string> {
  if (!validate(document)) throw new Error('Project document failed validation');
  const root = projectRoot(directory);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(root, 'autosave', `${stamp}-${randomUUID()}.json`);
  await mkdir(join(root, 'autosave'), { recursive: true });
  await writeJsonAtomically(path, document);
  return path;
}

export async function appendCutaiAudit(directory: string, event: Record<string, unknown>): Promise<void> {
  const root = projectRoot(directory);
  const path = join(root, 'audit', 'events.ndjson');
  await mkdir(join(root, 'audit'), { recursive: true });
  await writeFile(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, { encoding: 'utf8', flag: 'a' });
}

export function cutaiProjectDisplayName(directory: string): string {
  return basename(projectRoot(directory), '.cutai');
}
