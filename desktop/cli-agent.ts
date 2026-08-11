import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { issueWorkspaceCliToken, revokeWorkspaceCliToken, workspaceProjectMatchesRoot } from './workspace-project.ts';
import { runClaudeSdk, runCodexSdk } from './cli-agent-sdk.ts';
import { cliAgentRuntimeEnv } from './cli-agent-env.ts';
import { cliAgentMcpUrl, type CliAgentMcpContext } from './cli-agent-mcp.ts';
import { probeAcpStdio, runAcpStdio, type AcpProbeResult } from './acp-stdio.ts';
import { cancelEditorOwner, releaseEditorOwner } from '../server/external-agent/broker.ts';

export type CliAgentKind = 'claude' | 'codex' | 'custom-acp';
export type CliReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type CliFileAccess = 'proposal-only' | 'workspace-write';

export type CliStreamPayload =
  | { type: 'status'; message: string }
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | { type: 'model'; model: string; requestedModel?: string }
  | { type: 'tool-start'; toolId?: string; name: string; args?: unknown }
  | { type: 'tool-result'; toolId?: string; name: string; result?: unknown }
  | { type: 'error'; message: string };
export type CliStreamEvent = CliStreamPayload & { runId: string };

export interface CliAgentModel {
  id: string;
  label: string;
  reasoningEfforts: CliReasoningEffort[];
  defaultReasoningEffort: CliReasoningEffort;
}

export interface CliAgentProfile {
  id: string;
  kind: CliAgentKind;
  name: string;
  executable: string;
  adapter: 'claude-agent-sdk' | 'codex-sdk' | 'acp-stdio';
  version: string;
  compatible: boolean;
  reason?: string;
  configDirectory?: string;
  fingerprint: string;
  authorizedRoots: string[];
  models: CliAgentModel[];
  defaultModel?: string;
  args?: string[];
  envAllowlist?: string[];
  startupTimeoutMs?: number;
  supportsHttpMcp?: boolean;
}

export interface CustomCliAgentInput {
  name: string;
  executable: string;
  args?: string[];
  envAllowlist?: string[];
  startupTimeoutMs?: number;
  enabled?: boolean;
}

export interface CliRunRequest {
  runId?: string;
  profileId: string;
  projectId: string;
  projectRoot: string;
  prompt: string;
  sessionId?: string;
  model?: string;
  reasoningEffort?: CliReasoningEffort;
  fileAccess?: CliFileAccess;
  planMode?: boolean;
  forkSession?: boolean;
}

export interface CliRunResult {
  runId: string;
  sessionId?: string;
  text: string;
  reasoning?: string;
  usage?: Record<string, unknown>;
  exitCode: number;
  stderrTail: string;
  actualModel?: string;
}

interface PersistedAuthorization {
  fingerprint: string;
  roots: string[];
  updatedAt: string;
}

interface PersistedCustomAcpProfile {
  id: string;
  name: string;
  executable: string;
  args: string[];
  envAllowlist: string[];
  startupTimeoutMs: number;
  enabled: boolean;
  probe?: AcpProbeResult;
  /** Configuration/executable fingerprint observed by the successful probe. */
  probeFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

interface PersistedRegistry {
  schemaVersion?: 2;
  customProfiles?: PersistedCustomAcpProfile[];
  authorizations?: Record<string, PersistedAuthorization>;
}

interface CliParseState {
  streamedText: boolean;
  streamedThinking: boolean;
}

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CUSTOM_EXPLICIT_NETWORK_ENV = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
] as const;

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    });
    killer.unref();
    return;
  }
  child.kill('SIGTERM');
}

async function existsFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

const fileHashCache = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; hash: string }>();

async function sha256File(path: string): Promise<string> {
  const info = await stat(path);
  const cached = fileHashCache.get(path);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs) return cached.hash;
  const bytes = await readFile(path);
  const hash = createHash('sha256').update(bytes).digest('hex');
  fileHashCache.set(path, { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, hash });
  return hash;
}

interface ActiveSdkRun {
  controller: AbortController;
  cliToken?: string;
  tokenRevoked: boolean;
  cancelled: boolean;
  timedOut: boolean;
  succeeded: boolean;
  completed: Promise<void>;
  markCompleted: () => void;
}

interface ActiveProbe {
  controller: AbortController;
  completed: Promise<void>;
  markCompleted: () => void;
}

function createActiveProbe(): ActiveProbe {
  const controller = new AbortController();
  let markCompleted = (): void => undefined;
  const completed = new Promise<void>((resolveCompleted) => { markCompleted = resolveCompleted; });
  return { controller, completed, markCompleted };
}

function createActiveSdkRun(controller: AbortController): ActiveSdkRun {
  let markCompleted = (): void => undefined;
  const completed = new Promise<void>((resolveCompleted) => { markCompleted = resolveCompleted; });
  return {
    controller,
    tokenRevoked: false,
    cancelled: false,
    timedOut: false,
    succeeded: false,
    completed,
    markCompleted,
  };
}

function validateCustomInput(input: CustomCliAgentInput): Omit<PersistedCustomAcpProfile, 'id' | 'probe' | 'createdAt' | 'updatedAt'> {
  const name = input.name.trim();
  if (!name || name.length > 100) throw new Error('Custom CLI name must be 1-100 characters');
  const executable = input.executable.trim();
  if (!isAbsolute(executable)) throw new Error('Custom CLI executable must be an absolute file path');
  const args = input.args ?? [];
  if (args.length > 64 || args.some((value) => typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 8 * 1024)) {
    throw new Error('Custom CLI accepts at most 64 arguments of 8 KiB each');
  }
  const envAllowlist = [...new Set(input.envAllowlist ?? [])];
  if (envAllowlist.length > 64 || envAllowlist.some((nameValue) => !ENV_NAME.test(nameValue))) {
    throw new Error('Custom CLI environment entries must be valid variable names');
  }
  const startupTimeoutMs = Math.round(input.startupTimeoutMs ?? 10_000);
  if (startupTimeoutMs < 1_000 || startupTimeoutMs > 60_000) {
    throw new Error('Custom CLI startup timeout must be between 1 and 60 seconds');
  }
  return {
    name,
    executable,
    args: [...args],
    envAllowlist,
    startupTimeoutMs,
    enabled: input.enabled !== false,
  };
}

async function customFingerprint(profile: PersistedCustomAcpProfile): Promise<string> {
  const executableHash = await sha256File(profile.executable);
  return createHash('sha256').update(JSON.stringify({
    executableHash,
    executable: profile.executable,
    args: profile.args,
    envAllowlist: profile.envAllowlist,
    startupTimeoutMs: profile.startupTimeoutMs,
  })).digest('hex');
}

function customRuntimeEnv(profile: Pick<PersistedCustomAcpProfile, 'envAllowlist'>): NodeJS.ProcessEnv {
  const env = cliAgentRuntimeEnv('custom-acp');
  for (const name of CUSTOM_EXPLICIT_NETWORK_ENV) delete env[name];
  for (const name of profile.envAllowlist) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

function isReasoningEffort(value: unknown): value is CliReasoningEffort {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max';
}

async function readClaudeModels(configDirectory?: string): Promise<{ models: CliAgentModel[]; defaultModel?: string }> {
  const fallback = ['sonnet', 'opus', 'haiku'].map((id) => ({
    id,
    label: id[0].toUpperCase() + id.slice(1),
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] as CliReasoningEffort[],
    defaultReasoningEffort: 'high' as const,
  }));
  if (!configDirectory) return { models: fallback, defaultModel: 'sonnet' };
  try {
    const settings = JSON.parse(await readFile(join(configDirectory, 'settings.json'), 'utf8')) as {
      model?: string;
      env?: Record<string, unknown>;
    };
    const aliases = ['SONNET', 'OPUS', 'HAIKU', 'FABLE'];
    const models = aliases.flatMap((alias): CliAgentModel[] => {
      const id = alias.toLowerCase();
      const configured = settings.env?.[`ANTHROPIC_DEFAULT_${alias}_MODEL`];
      const label = settings.env?.[`ANTHROPIC_DEFAULT_${alias}_MODEL_NAME`];
      if (typeof configured !== 'string' || !configured.trim()) return [];
      return [{
        id,
        label: typeof label === 'string' && label.trim() ? label.trim() : configured,
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultReasoningEffort: 'high',
      }];
    });
    return {
      models: models.length ? models : fallback,
      defaultModel: typeof settings.model === 'string' ? settings.model : models[0]?.id || 'sonnet',
    };
  } catch {
    return { models: fallback, defaultModel: 'sonnet' };
  }
}

async function readCodexModels(configDirectory?: string): Promise<{ models: CliAgentModel[]; defaultModel?: string }> {
  if (!configDirectory) return { models: [] };
  let defaultModel: string | undefined;
  try {
    const config = await readFile(join(configDirectory, 'config.toml'), 'utf8');
    defaultModel = config.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
  } catch { /* use catalog default */ }
  try {
    const cache = JSON.parse(await readFile(join(configDirectory, 'models_cache.json'), 'utf8')) as {
      models?: Array<{
        slug?: unknown;
        display_name?: unknown;
        default_reasoning_level?: unknown;
        supported_reasoning_levels?: Array<{ effort?: unknown }>;
      }>;
    };
    const models = (cache.models ?? []).flatMap((item): CliAgentModel[] => {
      if (typeof item.slug !== 'string') return [];
      const efforts = (item.supported_reasoning_levels ?? [])
        .map((level) => level.effort)
        .filter(isReasoningEffort);
      return [{
        id: item.slug,
        label: typeof item.display_name === 'string' ? item.display_name : item.slug,
        reasoningEfforts: efforts.length ? efforts : ['low', 'medium', 'high'],
        defaultReasoningEffort: isReasoningEffort(item.default_reasoning_level) ? item.default_reasoning_level : 'medium',
      }];
    });
    return { models, defaultModel: defaultModel || models[0]?.id };
  } catch {
    return { models: [], defaultModel };
  }
}

function unique(values: Array<string | undefined>): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => !!value)
        .map((value) => resolve(value)),
    ),
  ];
}

function collectStrings(value: unknown, keys: ReadonlySet<string>, out: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, keys, out);
    return;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key) && typeof item === 'string' && item.trim()) out.push(item);
    else collectStrings(item, keys, out);
  }
}

function parseClaudeEvent(
  value: unknown,
  text: string[],
  reasoning: string[],
  state: CliParseState,
  emit?: (event: CliStreamPayload) => void,
): string | undefined {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const streamEvent = row.type === 'stream_event' && row.event && typeof row.event === 'object'
    ? row.event as Record<string, unknown>
    : null;
  if (streamEvent?.type === 'content_block_delta' && streamEvent.delta && typeof streamEvent.delta === 'object') {
    const delta = streamEvent.delta as Record<string, unknown>;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      state.streamedText = true;
      emit?.({ type: 'text', delta: delta.text });
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      state.streamedThinking = true;
      emit?.({ type: 'thinking', delta: delta.thinking });
    }
  }
  if (row.type === 'result' && typeof row.result === 'string' && text.length === 0) {
    text.push(row.result);
    if (!state.streamedText) emit?.({ type: 'text', delta: row.result });
  }
  if (typeof row.session_id === 'string') return row.session_id;
  const message = row.message && typeof row.message === 'object' ? row.message as Record<string, unknown> : null;
  if (message && Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      const block = part as Record<string, unknown>;
      if (block.type === 'text' && typeof block.text === 'string') {
        text.push(block.text);
        if (!state.streamedText) emit?.({ type: 'text', delta: block.text });
      }
      if (block.type === 'thinking' || block.type === 'reasoning') {
        const thought = typeof block.thinking === 'string' ? block.thinking
          : typeof block.text === 'string' ? block.text : '';
        if (thought) {
          reasoning.push(thought);
          if (!state.streamedThinking) emit?.({ type: 'thinking', delta: thought });
        }
      }
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        emit?.({
          type: 'tool-start',
          ...(typeof block.id === 'string' ? { toolId: block.id } : {}),
          name: block.name,
          args: block.input,
        });
      }
      if (block.type === 'tool_result') {
        emit?.({
          type: 'tool-result',
          ...(typeof block.tool_use_id === 'string' ? { toolId: block.tool_use_id } : {}),
          name: 'tool',
          result: block.content,
        });
      }
    }
  }
  return undefined;
}

function parseCodexEvent(
  value: unknown,
  text: string[],
  reasoning: string[],
  emit?: (event: CliStreamPayload) => void,
): string | undefined {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (row.type === 'thread.started' && typeof row.thread_id === 'string') return row.thread_id;
  if ((row.type === 'item.started' || row.type === 'item.completed') && row.item && typeof row.item === 'object') {
    const item = row.item as Record<string, unknown>;
    const itemType = typeof item.type === 'string' ? item.type : 'tool';
    const toolId = typeof item.id === 'string' ? item.id : undefined;
    if (row.type === 'item.completed' && itemType === 'agent_message' && typeof item.text === 'string') {
      text.push(item.text);
      emit?.({ type: 'text', delta: item.text });
    }
    if (row.type === 'item.completed' && itemType === 'reasoning') {
      const thoughts: string[] = [];
      collectStrings(item, new Set(['text', 'summary']), thoughts);
      for (const thought of thoughts) {
        reasoning.push(thought);
        emit?.({ type: 'thinking', delta: thought });
      }
    }
    if (itemType !== 'agent_message' && itemType !== 'reasoning') {
      const name = typeof item.name === 'string' ? item.name : itemType;
      if (row.type === 'item.started') {
        emit?.({
          type: 'tool-start',
          ...(toolId ? { toolId } : {}),
          name,
          args: item.command ?? item.arguments ?? item.input,
        });
      } else {
        emit?.({
          type: 'tool-result',
          ...(toolId ? { toolId } : {}),
          name,
          result: item.output ?? item.result ?? item.status,
        });
      }
    }
  }
  return undefined;
}

export class CliAgentHost {
  private readonly registryPath: string;
  private readonly sessionDir: string;
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();
  private readonly sdkRuns = new Map<string, ActiveSdkRun>();
  private readonly probeRuns = new Map<string, ActiveProbe>();
  private builtinProfilesCache?: { at: number; profiles: CliAgentProfile[] };
  private origin = '';
  private closing = false;
  private closePromise?: Promise<void>;

  constructor(userDataPath: string) {
    this.registryPath = join(userDataPath, 'cli-agents.json');
    this.sessionDir = join(userDataPath, 'cli-sessions');
    // Keep the legacy bridge type-checked until custom ACP gets its own adapter;
    // Claude and Codex never enter it after the SDK routing below.
    void this.runCodexAppServer;
  }

  setOrigin(origin: string): void {
    this.origin = origin.replace(/\/$/, '');
  }

  private async readRegistry(): Promise<PersistedRegistry> {
    try {
      const parsed = JSON.parse(await readFile(this.registryPath, 'utf8')) as PersistedRegistry;
      return {
        schemaVersion: 2,
        customProfiles: Array.isArray(parsed.customProfiles) ? parsed.customProfiles : [],
        authorizations: parsed.authorizations ?? {},
      };
    } catch {
      return { schemaVersion: 2, customProfiles: [], authorizations: {} };
    }
  }

  private async writeRegistry(value: PersistedRegistry): Promise<void> {
    await mkdir(dirname(this.registryPath), { recursive: true });
    const temporary = `${this.registryPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ ...value, schemaVersion: 2 }, null, 2)}\n`, 'utf8');
      await rename(temporary, this.registryPath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async createCustomProfile(input: CustomCliAgentInput): Promise<CliAgentProfile> {
    const values = validateCustomInput(input);
    if (!await existsFile(values.executable)) throw new Error('Custom CLI executable does not exist or is not a file');
    const registry = await this.readRegistry();
    const now = new Date().toISOString();
    const stored: PersistedCustomAcpProfile = {
      id: `acp-${randomUUID()}`,
      ...values,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeRegistry({
      ...registry,
      customProfiles: [...(registry.customProfiles ?? []), stored],
    });
    return (await this.profiles()).find((profile) => profile.id === stored.id)!;
  }

  async updateCustomProfile(profileId: string, input: CustomCliAgentInput): Promise<CliAgentProfile> {
    const values = validateCustomInput(input);
    if (!await existsFile(values.executable)) throw new Error('Custom CLI executable does not exist or is not a file');
    const registry = await this.readRegistry();
    const index = (registry.customProfiles ?? []).findIndex((profile) => profile.id === profileId);
    if (index < 0) throw new Error('Custom CLI profile not found');
    const current = registry.customProfiles![index];
    const next: PersistedCustomAcpProfile = {
      id: current.id,
      ...values,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    const customProfiles = [...registry.customProfiles!];
    customProfiles[index] = next;
    await this.writeRegistry({ ...registry, customProfiles });
    return (await this.profiles()).find((profile) => profile.id === profileId)!;
  }

  async deleteCustomProfile(profileId: string): Promise<void> {
    const registry = await this.readRegistry();
    const customProfiles = (registry.customProfiles ?? []).filter((profile) => profile.id !== profileId);
    if (customProfiles.length === (registry.customProfiles ?? []).length) {
      throw new Error('Built-in or unknown CLI profiles cannot be deleted');
    }
    const authorizations = { ...(registry.authorizations ?? {}) };
    delete authorizations[profileId];
    await this.writeRegistry({ ...registry, customProfiles, authorizations });
  }

  async revoke(profileId: string, projectRoot: string): Promise<void> {
    const registry = await this.readRegistry();
    const authorization = registry.authorizations?.[profileId];
    if (!authorization) return;
    const root = resolve(projectRoot);
    await this.writeRegistry({
      ...registry,
      authorizations: {
        ...(registry.authorizations ?? {}),
        [profileId]: {
          ...authorization,
          roots: authorization.roots.filter((candidate) => resolve(candidate) !== root),
          updatedAt: new Date().toISOString(),
        },
      },
    });
  }

  async probeCustomProfile(profileId: string): Promise<CliAgentProfile> {
    if (this.closing) throw new Error('CutAI is closing; new CLI probes are disabled');
    if (this.probeRuns.has(profileId)) throw new Error('This custom CLI handshake is already running');
    const activeProbe = createActiveProbe();
    this.probeRuns.set(profileId, activeProbe);
    try {
      const registry = await this.readRegistry();
      const index = (registry.customProfiles ?? []).findIndex((profile) => profile.id === profileId);
      if (index < 0) throw new Error('Custom CLI profile not found');
      const stored = registry.customProfiles![index];
      const fingerprintBefore = await customFingerprint(stored);
      let probe = await probeAcpStdio({
        executable: stored.executable,
        args: stored.args,
        cwd: dirname(stored.executable),
        env: customRuntimeEnv(stored),
        startupTimeoutMs: stored.startupTimeoutMs,
        signal: activeProbe.controller.signal,
      });
      const fingerprintAfter = await customFingerprint(stored);
      const probeFingerprint = fingerprintBefore === fingerprintAfter ? fingerprintAfter : undefined;
      if (!probeFingerprint) {
        probe = {
          ...probe,
          compatible: false,
          reason: 'Custom CLI executable or launch configuration changed during the ACP handshake; test it again',
        };
      }
      const customProfiles = [...registry.customProfiles!];
      customProfiles[index] = {
        ...stored,
        probe,
        probeFingerprint,
        updatedAt: new Date().toISOString(),
      };
      await this.writeRegistry({ ...registry, customProfiles });
      return (await this.profiles()).find((profile) => profile.id === profileId)!;
    } finally {
      activeProbe.markCompleted();
      this.probeRuns.delete(profileId);
    }
  }

  private async appendWorkspaceRecord(
    root: string,
    section: 'audit' | 'sessions',
    fileName: string,
    value: unknown,
  ): Promise<void> {
    const directory = join(root, '.cutai', section);
    await mkdir(directory, { recursive: true });
    await appendFile(join(directory, fileName), `${JSON.stringify(value)}\n`, 'utf8');
  }

  private async versionOf(executable: string): Promise<string> {
    return new Promise((resolveVersion) => {
      const child = spawn(executable, ['--version'], {
        windowsHide: true,
        shell: false,
        env: cliAgentRuntimeEnv(executable.toLowerCase().includes('claude') ? 'claude' : 'codex'),
      });
      let output = '';
      const timer = setTimeout(() => { child.kill(); resolveVersion('unknown'); }, 4_000);
      child.stdout.on('data', (chunk) => { output += String(chunk); });
      child.stderr.on('data', (chunk) => { output += String(chunk); });
      child.on('error', () => { clearTimeout(timer); resolveVersion('unavailable'); });
      child.on('exit', () => { clearTimeout(timer); resolveVersion(output.trim().split(/\r?\n/)[0] || 'unknown'); });
    });
  }

  async profiles(): Promise<CliAgentProfile[]> {
    if (this.closing) throw new Error('CutAI is closing; CLI discovery is disabled');
    const claudeRoot = process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : undefined;
    const codexHome = process.env.CODEX_HOME || (process.env.USERPROFILE ? join(process.env.USERPROFILE, '.codex') : undefined);
    const candidates: Array<{ id: string; kind: 'claude' | 'codex'; name: string; adapter: CliAgentProfile['adapter']; paths: string[]; config?: string }> = [
      {
        id: 'claude-local',
        kind: 'claude',
        name: 'Claude CLI',
        adapter: 'claude-agent-sdk',
        paths: unique([claudeRoot]),
        config: process.env.CLAUDE_CONFIG_DIR || (process.env.USERPROFILE ? join(process.env.USERPROFILE, '.claude') : undefined),
      },
      {
        id: 'codex-local',
        kind: 'codex',
        name: 'Codex CLI',
        adapter: 'codex-sdk',
        paths: unique([
          codexHome ? join(codexHome, '.sandbox-bin', 'codex.exe') : undefined,
          codexHome ? join(codexHome, 'plugins', '.plugin-appserver', 'codex.exe') : undefined,
          process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'codex.exe') : undefined,
        ]),
        config: codexHome,
      },
    ];
    const registry = await this.readRegistry();
    const profiles: CliAgentProfile[] = [];
    const cachedBuiltins = this.builtinProfilesCache;
    if (cachedBuiltins && Date.now() - cachedBuiltins.at < 30_000) {
      profiles.push(...cachedBuiltins.profiles.map((profile) => {
        const saved = registry.authorizations?.[profile.id];
        return {
          ...profile,
          authorizedRoots: saved?.fingerprint === profile.fingerprint ? saved.roots : [],
        };
      }));
    } else for (const candidate of candidates) {
      const executable = (await Promise.all(candidate.paths.map(async (path) => await existsFile(path) ? path : null)))
        .find((path): path is string => !!path);
      if (!executable) {
        profiles.push({
          id: candidate.id,
          kind: candidate.kind,
          name: candidate.name,
          executable: '',
          adapter: candidate.adapter,
          version: '',
          compatible: false,
          reason: '未找到可直接启动的本机 CLI',
          configDirectory: candidate.config,
          fingerprint: '',
          authorizedRoots: [],
          models: [],
        });
        continue;
      }
      const version = await this.versionOf(executable);
      const fingerprint = await sha256File(executable);
      const saved = registry.authorizations?.[candidate.id];
      const catalog = candidate.kind === 'claude'
        ? await readClaudeModels(candidate.config)
        : await readCodexModels(candidate.config);
      profiles.push({
        id: candidate.id,
        kind: candidate.kind,
        name: candidate.name,
        executable,
        adapter: candidate.adapter,
        version,
        compatible: version !== 'unavailable',
        ...(version === 'unavailable' ? { reason: 'CLI 无法启动' } : {}),
        configDirectory: candidate.config,
        fingerprint,
        authorizedRoots: saved?.fingerprint === fingerprint ? saved.roots : [],
        models: catalog.models,
        defaultModel: catalog.defaultModel,
      });
    }
    if (!cachedBuiltins || Date.now() - cachedBuiltins.at >= 30_000) {
      this.builtinProfilesCache = {
        at: Date.now(),
        profiles: profiles.map((profile) => ({ ...profile, authorizedRoots: [] })),
      };
    }
    for (const stored of registry.customProfiles ?? []) {
      const executableExists = isAbsolute(stored.executable) && await existsFile(stored.executable);
      let fingerprint = '';
      if (executableExists) {
        try { fingerprint = await customFingerprint(stored); } catch { /* reported as unavailable below */ }
      }
      const saved = registry.authorizations?.[stored.id];
      const probed = stored.probe?.compatible === true && stored.probeFingerprint === fingerprint;
      const compatible = stored.enabled && executableExists && !!fingerprint && probed;
      profiles.push({
        id: stored.id,
        kind: 'custom-acp',
        name: stored.name,
        executable: executableExists ? stored.executable : '',
        adapter: 'acp-stdio',
        version: stored.probe?.version || (stored.probe?.protocolVersion ? `ACP v${stored.probe.protocolVersion}` : ''),
        compatible,
        ...(!compatible ? {
          reason: !stored.enabled
            ? '已停用'
            : !executableExists
              ? '找不到自定义 CLI 可执行文件'
              : stored.probeFingerprint && stored.probeFingerprint !== fingerprint
                ? '自定义 CLI 可执行文件或启动配置已变化，需要重新测试 ACP 握手'
                : stored.probe?.reason || '需要先测试 ACP 握手',
        } : {}),
        fingerprint,
        authorizedRoots: saved?.fingerprint === fingerprint ? saved.roots : [],
        models: [],
        args: [...stored.args],
        envAllowlist: [...stored.envAllowlist],
        startupTimeoutMs: stored.startupTimeoutMs,
        supportsHttpMcp: stored.probe?.supportsHttpMcp === true,
      });
    }
    return profiles;
  }

  async authorize(profileId: string, projectRoot: string, fingerprint: string): Promise<void> {
    if (!isAbsolute(projectRoot)) throw new Error('Project root must be absolute');
    const root = resolve(projectRoot);
    const profile = (await this.profiles()).find((item) => item.id === profileId);
    if (!profile?.compatible || profile.fingerprint !== fingerprint) throw new Error('CLI profile changed; refresh and confirm again');
    const registry = await this.readRegistry();
    const current = registry.authorizations?.[profileId];
    const roots = [...new Set([...(current?.fingerprint === fingerprint ? current.roots : []), root])];
    await this.writeRegistry({
      ...registry,
      authorizations: {
        ...(registry.authorizations ?? {}),
        [profileId]: { fingerprint, roots, updatedAt: new Date().toISOString() },
      },
    });
    await this.appendWorkspaceRecord(root, 'audit', 'cli-authorizations.jsonl', {
      type: 'cli_authorized',
      at: new Date().toISOString(),
      profileId,
      kind: profile.kind,
      executable: profile.executable,
      version: profile.version,
      adapter: profile.adapter,
      fingerprint,
      projectRoot: root,
      configDirectory: profile.configDirectory,
      permission: profile.kind === 'custom-acp'
        ? 'current-user-process-and-cutai-manual-proposals'
        : 'read-only-filesystem-and-cutai-proposals',
    });
  }

  private async argsFor(profile: CliAgentProfile, request: CliRunRequest, runId: string): Promise<string[]> {
    const cliToken = issueWorkspaceCliToken(request.projectId, {
      mcpMode: request.planMode ? 'read-only' : 'manual-edit',
    });
    const mcpUrl = `${this.origin}/api/external-mcp/mcp?cutaiCliToken=${encodeURIComponent(cliToken)}`;
    const directEdit = request.fileAccess === 'workspace-write';
    const instruction = `${request.prompt}\n\nCutAI project id: ${request.projectId}. `
      + (directEdit
        ? 'The user enabled direct workspace editing. You may edit files inside the project root directly. Prefer CutAI MCP tools for timeline edits so the open editor stays synchronized. Never access paths outside the project root. '
        : 'You have read-only filesystem access. If direct file reads are denied, use cutai_workspace_list_files and cutai_workspace_read_file. For timeline edits, use the CutAI MCP tools and submit a proposal; never modify .cutai files or source media directly.');
    if (profile.kind === 'claude') {
      await mkdir(this.sessionDir, { recursive: true });
      const mcpPath = join(this.sessionDir, `${runId}.mcp.json`);
      await writeFile(mcpPath, `${JSON.stringify({ mcpServers: { cutai: { type: 'http', url: mcpUrl } } })}\n`, 'utf8');
      return [
        '--print',
        '--verbose',
        '--include-partial-messages',
        '--input-format', 'text',
        '--output-format', 'stream-json',
        '--permission-mode', directEdit ? 'bypassPermissions' : 'plan',
        '--disallowedTools', directEdit ? 'Bash' : 'Write,Edit,MultiEdit,NotebookEdit,Bash',
        ...(request.model ? ['--model', request.model] : []),
        ...(request.reasoningEffort ? ['--effort', request.reasoningEffort] : []),
        '--strict-mcp-config',
        '--mcp-config', mcpPath,
        ...(request.sessionId ? ['--resume', request.sessionId] : ['--session-id', randomUUID()]),
        instruction,
      ];
    }
    const escapedUrl = JSON.stringify(mcpUrl);
    return [
      'exec',
      '--json',
      '--sandbox', directEdit ? 'danger-full-access' : 'read-only',
      '--skip-git-repo-check',
      '-C', request.projectRoot,
      ...(request.model ? ['--model', request.model] : []),
      ...(request.reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(request.reasoningEffort)}`] : []),
      '-c', `mcp_servers.cutai.url=${escapedUrl}`,
      ...(request.sessionId ? ['resume', request.sessionId, instruction] : [instruction]),
    ];
  }

  private async runCodexAppServer(
    profile: CliAgentProfile,
    request: CliRunRequest,
    root: string,
    runId: string,
    onEvent?: (event: CliStreamEvent) => void,
  ): Promise<CliRunResult> {
    const emit = (event: CliStreamPayload): void => onEvent?.({ runId, ...event });
    const directEdit = request.fileAccess === 'workspace-write';
    const cliToken = issueWorkspaceCliToken(request.projectId, {
      mcpMode: request.planMode ? 'read-only' : 'manual-edit',
    });
    const mcpUrl = `${this.origin}/api/external-mcp/mcp?cutaiCliToken=${encodeURIComponent(cliToken)}`;
    const instruction = `${request.prompt}\n\nCutAI project id: ${request.projectId}. `
      + (directEdit
        ? 'The user enabled direct workspace editing. You may edit files inside the project root directly. Prefer CutAI MCP tools for timeline edits so the open editor stays synchronized. Never access paths outside the project root.'
        : 'You have read-only filesystem access. If direct file reads are denied, use cutai_workspace_list_files and cutai_workspace_read_file. For timeline edits, use the CutAI MCP tools and submit a proposal; never modify .cutai files or source media directly.');
    return new Promise((resolveRun, reject) => {
      const child = spawn(profile.executable, [
        'app-server',
        '--stdio',
        '-c', `mcp_servers.cutai.url=${JSON.stringify(mcpUrl)}`,
      ], {
        cwd: root,
        shell: false,
        windowsHide: true,
        env: cliAgentRuntimeEnv(profile.kind),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.processes.set(runId, child);
      emit({ type: 'status', message: `${profile.name} app-server 已启动，正在建立流式会话…` });
      let stdoutBuffer = '';
      let stderr = '';
      let sessionId = request.sessionId;
      let usage: Record<string, unknown> | undefined;
      let settled = false;
      const textParts: string[] = [];
      const reasoningParts: string[] = [];
      const send = (value: unknown): void => {
        child.stdin.write(`${JSON.stringify(value)}\n`, 'utf8');
      };
      const finishError = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.processes.delete(runId);
        terminateProcessTree(child);
        const normalized = error instanceof Error ? error : new Error(String(error));
        emit({ type: 'error', message: normalized.message });
        reject(normalized);
      };
      const finishSuccess = async (turn?: Record<string, unknown>): Promise<void> => {
        if (settled) return;
        const status = turn && typeof turn.status === 'string' ? turn.status : 'completed';
        if (status === 'failed') {
          finishError(new Error(JSON.stringify(turn?.error ?? 'Codex turn failed')));
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.processes.delete(runId);
        terminateProcessTree(child);
        const result: CliRunResult = {
          runId,
          sessionId,
          text: textParts.join('').trim(),
          reasoning: reasoningParts.join('').trim() || undefined,
          usage,
          exitCode: 0,
          stderrTail: stderr,
        };
        try {
          await this.appendWorkspaceRecord(root, 'sessions', `${profile.id}.jsonl`, {
            type: 'cli_turn',
            at: new Date().toISOString(),
            runId,
            sessionId,
            profileId: profile.id,
            prompt: request.prompt,
            response: result.text,
            reasoning: result.reasoning,
            fileAccess: request.fileAccess ?? 'proposal-only',
            usage,
            exitCode: 0,
          });
        } catch (error) {
          reject(new Error(`CLI completed but the workspace session could not be saved: ${String(error)}`));
          return;
        }
        emit({ type: 'status', message: 'CLI 已完成（流式会话）' });
        resolveRun(result);
      };
      const timer = setTimeout(() => finishError(new Error('CLI session timed out')), RUN_TIMEOUT_MS);
      const startThread = (): void => {
        send({
          id: 1,
          method: request.sessionId ? 'thread/resume' : 'thread/start',
          params: {
            ...(request.sessionId ? { threadId: request.sessionId } : {}),
            cwd: root,
            approvalPolicy: 'never',
            sandbox: directEdit ? 'danger-full-access' : 'read-only',
            ...(request.model ? { model: request.model } : {}),
          },
        });
      };
      const startTurn = (): void => {
        if (!sessionId) {
          finishError(new Error('Codex app-server did not return a thread id'));
          return;
        }
        send({
          id: 2,
          method: 'turn/start',
          params: {
            threadId: sessionId,
            input: [{ type: 'text', text: instruction }],
            cwd: root,
            approvalPolicy: 'never',
            summary: 'detailed',
            ...(request.model ? { model: request.model } : {}),
            ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
          },
        });
      };
      const parseLine = (line: string): void => {
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('CLI protocol message exceeds 16 MiB');
        if (!line.trim()) return;
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row.error && typeof row.id !== 'undefined') {
          throw new Error(`Codex app-server request failed: ${JSON.stringify(row.error)}`);
        }
        if (row.id === 0) {
          send({ method: 'initialized', params: {} });
          startThread();
          return;
        }
        if (row.id === 1) {
          const result = row.result && typeof row.result === 'object' ? row.result as Record<string, unknown> : {};
          const thread = result.thread && typeof result.thread === 'object' ? result.thread as Record<string, unknown> : {};
          if (typeof thread.id === 'string') sessionId = thread.id;
          startTurn();
          return;
        }
        const params = row.params && typeof row.params === 'object' ? row.params as Record<string, unknown> : {};
        if (row.method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
          textParts.push(params.delta);
          emit({ type: 'text', delta: params.delta });
        } else if ((row.method === 'item/reasoning/summaryTextDelta' || row.method === 'item/reasoning/textDelta')
          && typeof params.delta === 'string') {
          reasoningParts.push(params.delta);
          emit({ type: 'thinking', delta: params.delta });
        } else if (row.method === 'item/started') {
          const item = params.item && typeof params.item === 'object' ? params.item as Record<string, unknown> : {};
          const name = typeof item.name === 'string' ? item.name : typeof item.type === 'string' ? item.type : 'tool';
          emit({
            type: 'tool-start',
            ...(typeof item.id === 'string' ? { toolId: item.id } : {}),
            name,
            args: item.command ?? item.arguments ?? item.input,
          });
        } else if (row.method === 'item/completed') {
          const item = params.item && typeof params.item === 'object' ? params.item as Record<string, unknown> : {};
          const itemType = typeof item.type === 'string' ? item.type : 'tool';
          if (itemType !== 'agentMessage' && itemType !== 'reasoning') {
            emit({
              type: 'tool-result',
              ...(typeof item.id === 'string' ? { toolId: item.id } : {}),
              name: typeof item.name === 'string' ? item.name : itemType,
              result: item.output ?? item.result ?? item.status,
            });
          }
        } else if (row.method === 'thread/tokenUsage/updated') {
          usage = params.tokenUsage && typeof params.tokenUsage === 'object'
            ? params.tokenUsage as Record<string, unknown>
            : params;
        } else if (row.method === 'turn/completed') {
          void finishSuccess(params.turn && typeof params.turn === 'object' ? params.turn as Record<string, unknown> : undefined);
        }
      };
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += String(chunk);
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        try { for (const line of lines) parseLine(line); }
        catch (error) { finishError(error); }
      });
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-STDERR_LIMIT);
      });
      child.on('error', finishError);
      child.on('exit', (code) => {
        if (!settled) finishError(new Error(stderr.trim() || `codex app-server exited with ${code ?? -1}`));
      });
      send({
        id: 0,
        method: 'initialize',
        params: { clientInfo: { name: 'cutai', title: 'CutAI', version: '0.1.6' }, capabilities: {} },
      });
    });
  }

  private abortSdkRun(runId: string, reason: string, timedOut = false): boolean {
    const active = this.sdkRuns.get(runId);
    if (!active) return false;
    if (timedOut) active.timedOut = true;
    if (!active.cancelled) {
      active.cancelled = true;
      if (active.cliToken) cancelEditorOwner(active.cliToken, reason);
      if (active.cliToken && !active.tokenRevoked) {
        revokeWorkspaceCliToken(active.cliToken);
        active.tokenRevoked = true;
      }
      active.controller.abort();
    }
    return true;
  }

  private finishSdkRun(runId: string): void {
    const active = this.sdkRuns.get(runId);
    if (!active) return;
    if (active.cliToken) {
      if (active.succeeded) releaseEditorOwner(active.cliToken);
      else cancelEditorOwner(active.cliToken, active.timedOut ? 'CLI Agent run timed out' : 'CLI Agent run failed');
      if (!active.tokenRevoked) revokeWorkspaceCliToken(active.cliToken);
    }
    active.markCompleted();
    this.sdkRuns.delete(runId);
  }

  private assertRunCanStart(runId: string): void {
    if (this.closing) throw new Error('CutAI is closing; new CLI runs are disabled');
    if (this.sdkRuns.has(runId) || this.processes.has(runId)) {
      throw new Error(`CLI run ${runId} is already active`);
    }
  }

  async run(request: CliRunRequest, onEvent?: (event: CliStreamEvent) => void): Promise<CliRunResult> {
    if (this.closing) throw new Error('CutAI is closing; new CLI runs are disabled');
    const root = resolve(request.projectRoot);
    const profile = (await this.profiles()).find((item) => item.id === request.profileId);
    if (!profile?.compatible || !profile.executable) throw new Error('CLI is unavailable or incompatible');
    if (!profile.authorizedRoots.map((value) => resolve(value)).includes(root)) {
      throw new Error('CLI access to this project has not been authorized');
    }
    const runRegistry = await this.readRegistry();
    const runAuthorization = runRegistry.authorizations?.[profile.id];
    if (runAuthorization?.fingerprint !== profile.fingerprint
      || !runAuthorization.roots.map((value) => resolve(value)).includes(root)) {
      throw new Error('CLI authorization changed before the run started; authorize this project again');
    }
    if (!workspaceProjectMatchesRoot(request.projectId, root)) {
      throw new Error('CLI project id does not match the authorized workspace root');
    }
    const runId = request.runId || randomUUID();
    if (this.sdkRuns.has(runId) || this.processes.has(runId)) {
      throw new Error(`CLI run ${runId} is already active`);
    }
    if (profile.kind === 'custom-acp') {
      const stored = runRegistry.customProfiles?.find((item) => item.id === profile.id);
      if (!stored) throw new Error('Custom ACP profile no longer exists');
      const runFingerprint = await customFingerprint(stored);
      if (
        !stored.enabled
        || stored.probe?.compatible !== true
        || stored.probeFingerprint !== runFingerprint
        || runFingerprint !== profile.fingerprint
      ) {
        throw new Error('Custom ACP profile changed after authorization; test the handshake and authorize it again');
      }
      this.assertRunCanStart(runId);
      const controller = new AbortController();
      const active = createActiveSdkRun(controller);
      this.sdkRuns.set(runId, active);
      const timer = setTimeout(() => {
        this.abortSdkRun(runId, 'CLI Agent run timed out', true);
      }, RUN_TIMEOUT_MS);
      let cliToken: string | undefined;
      let mcpUrl: string | undefined;
      if (this.origin && stored.probe.supportsHttpMcp) {
        cliToken = issueWorkspaceCliToken(request.projectId, {
          mcpMode: request.planMode ? 'read-only' : 'manual-edit',
        });
        active.cliToken = cliToken;
        mcpUrl = cliAgentMcpUrl(this.origin, cliToken);
      }
      const directEdit = request.fileAccess === 'workspace-write';
      const instruction = `${request.prompt}\n\nCutAI project id: ${request.projectId}. `
        + (mcpUrl
          ? 'Use the CutAI MCP tools for timeline operations. Timeline edits require manual review in CutAI. '
          : 'This ACP Agent does not expose CutAI MCP tools in this run; answer without claiming timeline edits. ')
        + (directEdit
          ? 'The user explicitly enabled direct workspace editing. The ACP process still runs with the current operating-system user permissions.'
          : 'Do not modify project files directly. ACP is a protocol, not an operating-system sandbox.');
      try {
        const acpResult = await runAcpStdio({
          executable: stored.executable,
          args: stored.args,
          cwd: root,
          env: customRuntimeEnv(stored),
          startupTimeoutMs: stored.startupTimeoutMs,
          prompt: instruction,
          mcpUrl,
          signal: controller.signal,
          onEvent: (event) => onEvent?.({ runId, ...event }),
        });
        const result: CliRunResult = {
          runId,
          // Session resume is capability-dependent and is not assumed for a
          // generic ACP executable. Chat history is bridged by the UI instead.
          text: acpResult.text,
          reasoning: acpResult.reasoning,
          usage: acpResult.usage,
          exitCode: 0,
          stderrTail: acpResult.stderrTail,
          actualModel: acpResult.actualModel,
        };
        await this.appendWorkspaceRecord(root, 'sessions', `${profile.id}.jsonl`, {
          type: 'acp_turn',
          at: new Date().toISOString(),
          runId,
          profileId: profile.id,
          adapter: profile.adapter,
          prompt: request.prompt,
          response: result.text,
          reasoning: result.reasoning,
          fileAccess: request.fileAccess ?? 'proposal-only',
          usage: result.usage,
        });
        active.succeeded = true;
        return result;
      } catch (error) {
        const normalized = active.timedOut ? new Error('CLI session timed out') : error;
        this.abortSdkRun(runId, active.timedOut ? 'CLI Agent run timed out' : 'CLI Agent run failed', active.timedOut);
        onEvent?.({ runId, type: 'error', message: normalized instanceof Error ? normalized.message : String(normalized) });
        throw normalized;
      } finally {
        clearTimeout(timer);
        this.finishSdkRun(runId);
      }
    }
    if (profile.kind === 'claude' || profile.kind === 'codex') {
      this.assertRunCanStart(runId);
      const controller = new AbortController();
      const active = createActiveSdkRun(controller);
      this.sdkRuns.set(runId, active);
      const timer = setTimeout(() => {
        this.abortSdkRun(runId, 'CLI Agent run timed out', true);
      }, RUN_TIMEOUT_MS);
      let cliToken: string | undefined;
      let mcp: CliAgentMcpContext | undefined;
      if (this.origin) {
        cliToken = issueWorkspaceCliToken(request.projectId, {
          mcpMode: request.planMode ? 'read-only' : 'manual-edit',
        });
        active.cliToken = cliToken;
        mcp = { url: cliAgentMcpUrl(this.origin, cliToken) };
      }
      try {
        const result = profile.kind === 'claude'
          ? await runClaudeSdk(profile, request, runId, controller, onEvent, mcp)
          : await runCodexSdk(profile, request, runId, controller, onEvent, mcp);
        await this.appendWorkspaceRecord(root, 'sessions', `${profile.id}.jsonl`, {
          type: 'sdk_turn',
          at: new Date().toISOString(),
          runId,
          sessionId: result.sessionId,
          profileId: profile.id,
          adapter: profile.adapter,
          prompt: request.prompt,
          response: result.text,
          reasoning: result.reasoning,
          fileAccess: request.fileAccess ?? 'proposal-only',
          usage: result.usage,
        });
        active.succeeded = true;
        return result;
      } catch (error) {
        const normalized = active.timedOut ? new Error('CLI session timed out') : error;
        this.abortSdkRun(runId, active.timedOut ? 'CLI Agent run timed out' : 'CLI Agent run failed', active.timedOut);
        const message = normalized instanceof Error ? normalized.message : String(normalized);
        onEvent?.({ runId, type: 'error', message });
        throw normalized;
      } finally {
        clearTimeout(timer);
        this.finishSdkRun(runId);
      }
    }
    const args = await this.argsFor(profile, request, runId);
    this.assertRunCanStart(runId);
    const emit = (event: CliStreamPayload): void => onEvent?.({ runId, ...event });
    return new Promise((resolveRun, reject) => {
      const child = spawn(profile.executable, args, {
        cwd: root,
        shell: false,
        windowsHide: true,
        env: cliAgentRuntimeEnv(profile.kind),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.processes.set(runId, child);
      emit({ type: 'status', message: `${profile.name} 已启动，正在等待结构化事件…` });
      child.stdin.end();
      let stdoutBuffer = '';
      let stderr = '';
      let sessionId = request.sessionId;
      const text: string[] = [];
      const reasoning: string[] = [];
      const parseState: CliParseState = { streamedText: false, streamedThinking: false };
      let usage: Record<string, unknown> | undefined;
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.processes.delete(runId);
        const normalized = error instanceof Error ? error : new Error(String(error));
        emit({ type: 'error', message: normalized.message });
        reject(normalized);
      };
      const timer = setTimeout(() => {
        terminateProcessTree(child);
        fail(new Error('CLI session timed out'));
      }, RUN_TIMEOUT_MS);
      const parseLine = (line: string): void => {
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('CLI protocol message exceeds 16 MiB');
        if (!line.trim()) return;
        const value = JSON.parse(line) as unknown;
        const nextSession = profile.kind === 'claude'
          ? parseClaudeEvent(value, text, reasoning, parseState, emit)
          : parseCodexEvent(value, text, reasoning, emit);
        if (nextSession) sessionId = nextSession;
        if (value && typeof value === 'object' && 'usage' in value) usage = (value as { usage?: Record<string, unknown> }).usage;
      };
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += String(chunk);
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        try { for (const line of lines) parseLine(line); }
        catch (error) { terminateProcessTree(child); fail(error); }
      });
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-STDERR_LIMIT);
      });
      child.on('error', (error) => {
        fail(error);
      });
      child.on('exit', async (code) => {
        if (settled) return;
        clearTimeout(timer);
        this.processes.delete(runId);
        try { if (stdoutBuffer.trim()) parseLine(stdoutBuffer); } catch (error) { fail(error); return; }
        const exitCode = code ?? -1;
        if (exitCode !== 0 && text.length === 0) {
          fail(new Error(stderr.trim() || `${basename(profile.executable)} exited with ${exitCode}`));
          return;
        }
        const result: CliRunResult = {
          runId,
          sessionId,
          text: [...new Set(text)].join('\n\n').trim(),
          reasoning: reasoning.join('\n').trim() || undefined,
          usage,
          exitCode,
          stderrTail: stderr,
        };
        try {
          await this.appendWorkspaceRecord(root, 'sessions', `${profile.id}.jsonl`, {
            type: 'cli_turn',
            at: new Date().toISOString(),
            runId,
            sessionId,
            profileId: profile.id,
            prompt: request.prompt,
            response: result.text,
            reasoning: result.reasoning,
            fileAccess: request.fileAccess ?? 'proposal-only',
            usage,
            exitCode,
          });
        } catch (error) {
          fail(new Error(`CLI completed but the workspace session could not be saved: ${String(error)}`));
          return;
        }
        settled = true;
        emit({ type: 'status', message: `CLI 已完成（退出码 ${exitCode}）` });
        resolveRun(result);
      });
    });
  }

  cancel(runId: string): boolean {
    if (this.abortSdkRun(runId, 'CLI Agent run was cancelled by the user')) return true;
    const child = this.processes.get(runId);
    if (!child) return false;
    terminateProcessTree(child);
    this.processes.delete(runId);
    return true;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      const completions = [
        ...[...this.sdkRuns.values()].map((active) => active.completed),
        ...[...this.probeRuns.values()].map((active) => active.completed),
      ];
      for (const runId of this.sdkRuns.keys()) this.abortSdkRun(runId, 'CutAI is closing');
      for (const probe of this.probeRuns.values()) probe.controller.abort();
      for (const child of this.processes.values()) terminateProcessTree(child);
      this.processes.clear();
      if (!completions.length) return;
      await new Promise<void>((resolveClose) => {
        const timer = setTimeout(resolveClose, 5_000);
        void Promise.allSettled(completions).then(() => {
          clearTimeout(timer);
          resolveClose();
        });
      });
    })();
    return this.closePromise;
  }
}
