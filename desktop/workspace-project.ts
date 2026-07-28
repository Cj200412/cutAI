import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const WORKSPACE_PROJECT_VERSION = 2;
const META_DIR = '.cutai';
const MANIFEST_FILE = 'manifest.json';
const PROJECT_FILE = 'project.json';
const MEDIA_INDEX_FILE = 'media-index.json';
const IGNORED_DIRS = new Set([META_DIR, '.git', 'node_modules', '.cache', '.idea', '.vscode']);
const MEDIA_EXTENSIONS = new Map<string, WorkspaceMediaKind>([
  ['.mp4', 'video'], ['.mov', 'video'], ['.mkv', 'video'], ['.webm', 'video'], ['.avi', 'video'],
  ['.mp3', 'audio'], ['.wav', 'audio'], ['.m4a', 'audio'], ['.aac', 'audio'], ['.flac', 'audio'], ['.ogg', 'audio'],
  ['.png', 'image'], ['.jpg', 'image'], ['.jpeg', 'image'], ['.webp', 'image'], ['.bmp', 'image'],
  ['.gif', 'gif'], ['.svg', 'svg'],
  ['.srt', 'subtitle'], ['.vtt', 'subtitle'], ['.ass', 'subtitle'],
]);

export type WorkspaceMediaKind = 'video' | 'audio' | 'image' | 'gif' | 'svg' | 'subtitle';

export interface WorkspaceManifest {
  format: 'cutai-workspace';
  schemaVersion: typeof WORKSPACE_PROJECT_VERSION;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  appVersion: string;
}

export interface WorkspaceMediaRecord {
  id: string;
  name: string;
  kind: WorkspaceMediaKind;
  relativePath: string;
  bytes: number;
  modifiedAtMs: number;
  sha256: string;
  url: string;
}

export interface OpenWorkspaceResult<T> {
  rootPath: string;
  manifest: WorkspaceManifest;
  document: T;
  media: WorkspaceMediaRecord[];
}

const roots = new Map<string, string>();
const cliTokens = new Map<string, { projectId: string; expiresAt: number }>();

function metadataRoot(rootPath: string): string {
  return join(rootPath, META_DIR);
}

function validateRoot(input: unknown): string {
  if (typeof input !== 'string' || !isAbsolute(input)) throw new Error('Workspace path must be absolute');
  return resolve(input);
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function isManifest(value: unknown): value is WorkspaceManifest {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<WorkspaceManifest>;
  return row.format === 'cutai-workspace'
    && row.schemaVersion === WORKSPACE_PROJECT_VERSION
    && typeof row.projectId === 'string' && row.projectId.length > 0
    && typeof row.name === 'string' && row.name.length > 0
    && typeof row.createdAt === 'string' && typeof row.updatedAt === 'string'
    && typeof row.appVersion === 'string';
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function writeJsonAtomically(path: string, value: unknown, backup = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (backup) {
    await rm(`${path}.bak`, { force: true });
    try { await rename(path, `${path}.bak`); } catch { /* first save */ }
  }
  await rename(temp, path);
}

async function digestFile(path: string): Promise<string> {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveDigest(hash.digest('hex')));
  });
}

function mediaUrl(projectId: string, relativePath: string): string {
  const encoded = relativePath.split(/[\\/]/).map(encodeURIComponent).join('/');
  return `/workspace-media/${encodeURIComponent(projectId)}/${encoded}`;
}

async function scanDirectory(root: string, projectId: string): Promise<WorkspaceMediaRecord[]> {
  const rootReal = await realpath(root);
  const queue = [rootReal];
  const media: WorkspaceMediaRecord[] = [];
  while (queue.length) {
    const directory = queue.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = MEDIA_EXTENSIONS.get(extname(entry.name).toLowerCase());
      if (!kind) continue;
      const path = join(directory, entry.name);
      const actual = await realpath(path);
      if (!isWithin(rootReal, actual)) continue;
      const info = await stat(actual);
      const relativePath = relative(rootReal, actual);
      const sha256 = await digestFile(actual);
      media.push({
        id: `ws_${sha256.slice(0, 24)}`,
        name: entry.name,
        kind,
        relativePath,
        bytes: info.size,
        modifiedAtMs: info.mtimeMs,
        sha256,
        url: mediaUrl(projectId, relativePath),
      });
    }
  }
  return media.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function registerWorkspaceRoot(projectId: string, rootPath: string): void {
  roots.set(projectId, validateRoot(rootPath));
}

export function issueWorkspaceCliToken(projectId: string, ttlMs = 15 * 60 * 1000): string {
  if (!roots.has(projectId)) throw new Error('Workspace is not open');
  const token = randomUUID();
  cliTokens.set(token, { projectId, expiresAt: Date.now() + ttlMs });
  return token;
}

function rootForCliToken(token: string): { projectId: string; root: string } {
  const grant = cliTokens.get(token);
  if (!grant || grant.expiresAt < Date.now()) {
    cliTokens.delete(token);
    throw new Error('CLI workspace token is invalid or expired');
  }
  const root = roots.get(grant.projectId);
  if (!root) throw new Error('Workspace is not open');
  return { projectId: grant.projectId, root };
}

export async function listWorkspaceFilesForCli(token: string, requested = '.'): Promise<unknown> {
  const { projectId, root } = rootForCliToken(token);
  const rootReal = await realpath(root);
  const target = resolve(rootReal, requested);
  if (!isWithin(rootReal, target)) throw new Error('Path outside workspace');
  const targetReal = await realpath(target);
  if (!isWithin(rootReal, targetReal)) throw new Error('Path outside workspace');
  const info = await stat(targetReal);
  if (!info.isDirectory()) throw new Error('Requested path is not a directory');
  const entries = await readdir(targetReal, { withFileTypes: true });
  return {
    projectId,
    path: relative(rootReal, targetReal) || '.',
    entries: entries
      .filter((entry) => !entry.isSymbolicLink() && entry.name !== META_DIR)
      .map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' })),
  };
}

export async function readWorkspaceFileForCli(token: string, requested: string): Promise<unknown> {
  const { projectId, root } = rootForCliToken(token);
  if (!requested || requested === META_DIR || requested.startsWith(`${META_DIR}${sep}`) || requested.startsWith(`${META_DIR}/`)) {
    throw new Error('Reading CutAI metadata through the CLI is not allowed');
  }
  const rootReal = await realpath(root);
  const target = resolve(rootReal, requested);
  if (!isWithin(rootReal, target)) throw new Error('Path outside workspace');
  const targetReal = await realpath(target);
  if (!isWithin(rootReal, targetReal)) throw new Error('Path outside workspace');
  const info = await stat(targetReal);
  if (!info.isFile()) throw new Error('Requested path is not a file');
  if (info.size > 2 * 1024 * 1024) throw new Error('CLI text reads are limited to 2 MiB');
  if (MEDIA_EXTENSIONS.has(extname(targetReal).toLowerCase()) && !['.srt', '.vtt', '.ass', '.svg'].includes(extname(targetReal).toLowerCase())) {
    throw new Error('Binary media cannot be read as text');
  }
  return {
    projectId,
    path: relative(rootReal, targetReal),
    content: await readFile(targetReal, 'utf8'),
  };
}

export async function createWorkspaceProject<T>(
  rootPath: string,
  document: T,
  appVersion: string,
  requestedProjectId?: string,
): Promise<OpenWorkspaceResult<T>> {
  const root = validateRoot(rootPath);
  await mkdir(root, { recursive: true });
  const meta = metadataRoot(root);
  await mkdir(join(meta, 'autosave'), { recursive: true });
  await mkdir(join(meta, 'audit'), { recursive: true });
  await mkdir(join(meta, 'sessions'), { recursive: true });
  const now = new Date().toISOString();
  const manifest: WorkspaceManifest = {
    format: 'cutai-workspace',
    schemaVersion: WORKSPACE_PROJECT_VERSION,
    projectId: requestedProjectId?.trim() || randomUUID(),
    name: basename(root),
    createdAt: now,
    updatedAt: now,
    appVersion,
  };
  const media = await scanDirectory(root, manifest.projectId);
  await writeJsonAtomically(join(meta, MANIFEST_FILE), manifest);
  await writeJsonAtomically(join(meta, PROJECT_FILE), document);
  await writeJsonAtomically(join(meta, MEDIA_INDEX_FILE), media);
  registerWorkspaceRoot(manifest.projectId, root);
  return { rootPath: root, manifest, document, media };
}

export async function openWorkspaceProject<T>(
  rootPath: string,
  validate: (value: unknown) => value is T,
): Promise<OpenWorkspaceResult<T>> {
  const root = validateRoot(rootPath);
  const meta = metadataRoot(root);
  const manifestRaw = await readJson(join(meta, MANIFEST_FILE));
  if (!isManifest(manifestRaw)) throw new Error('Selected folder is not a compatible CutAI workspace');
  const document = await readJson(join(meta, PROJECT_FILE));
  if (!validate(document)) throw new Error('Workspace project data failed validation');
  const media = await scanDirectory(root, manifestRaw.projectId);
  await writeJsonAtomically(join(meta, MEDIA_INDEX_FILE), media);
  registerWorkspaceRoot(manifestRaw.projectId, root);
  return { rootPath: root, manifest: manifestRaw, document, media };
}

export async function saveWorkspaceProject<T>(
  rootPath: string,
  document: T,
  appVersion: string,
  validate: (value: unknown) => value is T,
): Promise<WorkspaceManifest> {
  if (!validate(document)) throw new Error('Workspace project data failed validation');
  const root = validateRoot(rootPath);
  const meta = metadataRoot(root);
  const manifestRaw = await readJson(join(meta, MANIFEST_FILE));
  if (!isManifest(manifestRaw)) throw new Error('Workspace manifest is invalid');
  const manifest = { ...manifestRaw, updatedAt: new Date().toISOString(), appVersion };
  await writeJsonAtomically(join(meta, PROJECT_FILE), document, true);
  await writeJsonAtomically(join(meta, MANIFEST_FILE), manifest);
  return manifest;
}

export async function rescanWorkspace(rootPath: string): Promise<WorkspaceMediaRecord[]> {
  const root = validateRoot(rootPath);
  const manifest = await readJson(join(metadataRoot(root), MANIFEST_FILE));
  if (!isManifest(manifest)) throw new Error('Workspace manifest is invalid');
  const media = await scanDirectory(root, manifest.projectId);
  await writeJsonAtomically(join(metadataRoot(root), MEDIA_INDEX_FILE), media);
  registerWorkspaceRoot(manifest.projectId, root);
  return media;
}

function contentType(path: string): string {
  const ext = extname(path).toLowerCase();
  return ({
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.srt': 'application/x-subrip', '.vtt': 'text/vtt', '.ass': 'text/plain',
  } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

/** Same-origin, read-only media endpoint with root containment and byte-range support. */
export async function serveWorkspaceMedia(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const raw = req.url ?? '';
  const match = /^\/workspace-media\/([^/]+)\/(.+?)(?:\?.*)?$/.exec(raw);
  if (!match) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.end();
    return true;
  }
  const projectId = decodeURIComponent(match[1]);
  const root = roots.get(projectId);
  if (!root) {
    res.statusCode = 404;
    res.end('Workspace is not open');
    return true;
  }
  try {
    const relativePath = match[2].split('/').map(decodeURIComponent).join(sep);
    const target = resolve(root, relativePath);
    const rootReal = await realpath(root);
    const targetReal = await realpath(target);
    if (!isWithin(rootReal, targetReal)) throw new Error('Path outside workspace');
    const info = await stat(targetReal);
    if (!info.isFile()) throw new Error('Not a file');
    const range = req.headers.range;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', contentType(targetReal));
    res.setHeader('Cache-Control', 'no-store');
    if (range) {
      const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!parsed) throw new Error('Invalid range');
      const start = parsed[1] ? Number(parsed[1]) : 0;
      const end = parsed[2] ? Math.min(Number(parsed[2]), info.size - 1) : info.size - 1;
      if (start > end || start >= info.size) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${info.size}`);
        res.end();
        return true;
      }
      res.statusCode = 206;
      res.setHeader('Content-Length', end - start + 1);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
      if (req.method === 'HEAD') res.end();
      else createReadStream(targetReal, { start, end }).pipe(res);
      return true;
    }
    res.statusCode = 200;
    res.setHeader('Content-Length', info.size);
    if (req.method === 'HEAD') res.end();
    else createReadStream(targetReal).pipe(res);
    return true;
  } catch {
    res.statusCode = 404;
    res.end('Workspace media not found');
    return true;
  }
}
