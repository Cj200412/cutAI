import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { issueWorkspaceCliToken } from './workspace-project.ts';
import { runClaudeSdk, runCodexSdk } from './cli-agent-sdk.ts';

export type CliAgentKind = 'claude' | 'codex' | 'custom-acp';
export type CliReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type CliFileAccess = 'proposal-only' | 'workspace-write';

export type CliStreamPayload =
  | { type: 'status'; message: string }
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
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
}

export interface CliRunResult {
  runId: string;
  sessionId?: string;
  text: string;
  reasoning?: string;
  usage?: Record<string, unknown>;
  exitCode: number;
  stderrTail: string;
}

interface PersistedAuthorization {
  fingerprint: string;
  roots: string[];
  updatedAt: string;
}

interface PersistedRegistry {
  authorizations?: Record<string, PersistedAuthorization>;
}

interface CliParseState {
  streamedText: boolean;
  streamedThinking: boolean;
}

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

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

async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
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

function runtimeEnv(kind: CliAgentKind): NodeJS.ProcessEnv {
  const allowed = [
    'SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'TEMP', 'TMP', 'LANG', 'LC_ALL', 'PATH', 'Path', 'PATHEXT', 'ComSpec',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  ];
  if (kind === 'claude') allowed.push('CLAUDE_CONFIG_DIR');
  if (kind === 'codex') allowed.push('CODEX_HOME');
  return Object.fromEntries(allowed.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
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
  private readonly sdkRuns = new Map<string, AbortController>();
  private origin = '';

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
    try { return JSON.parse(await readFile(this.registryPath, 'utf8')) as PersistedRegistry; }
    catch { return {}; }
  }

  private async writeRegistry(value: PersistedRegistry): Promise<void> {
    await mkdir(dirname(this.registryPath), { recursive: true });
    await writeFile(this.registryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
        env: runtimeEnv(executable.toLowerCase().includes('claude') ? 'claude' : 'codex'),
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
    for (const candidate of candidates) {
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
    return profiles;
  }

  async authorize(profileId: string, projectRoot: string, fingerprint: string): Promise<void> {
    const root = resolve(projectRoot);
    if (!isAbsolute(root)) throw new Error('Project root must be absolute');
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
      permission: 'read-only-filesystem-and-cutai-proposals',
    });
  }

  private async argsFor(profile: CliAgentProfile, request: CliRunRequest, runId: string): Promise<string[]> {
    const cliToken = issueWorkspaceCliToken(request.projectId);
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
    const cliToken = issueWorkspaceCliToken(request.projectId);
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
        env: runtimeEnv(profile.kind),
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

  async run(request: CliRunRequest, onEvent?: (event: CliStreamEvent) => void): Promise<CliRunResult> {
    const root = resolve(request.projectRoot);
    const profile = (await this.profiles()).find((item) => item.id === request.profileId);
    if (!profile?.compatible || !profile.executable) throw new Error('CLI is unavailable or incompatible');
    if (!profile.authorizedRoots.map((value) => resolve(value)).includes(root)) {
      throw new Error('CLI access to this project has not been authorized');
    }
    const runId = request.runId || randomUUID();
    if (profile.kind === 'claude' || profile.kind === 'codex') {
      const controller = new AbortController();
      this.sdkRuns.set(runId, controller);
      try {
        const result = profile.kind === 'claude'
          ? await runClaudeSdk(profile, request, runId, controller, onEvent)
          : await runCodexSdk(profile, request, runId, controller, onEvent);
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
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onEvent?.({ runId, type: 'error', message });
        throw error;
      } finally {
        this.sdkRuns.delete(runId);
      }
    }
    const args = await this.argsFor(profile, request, runId);
    const emit = (event: CliStreamPayload): void => onEvent?.({ runId, ...event });
    return new Promise((resolveRun, reject) => {
      const child = spawn(profile.executable, args, {
        cwd: root,
        shell: false,
        windowsHide: true,
        env: runtimeEnv(profile.kind),
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
    const sdkRun = this.sdkRuns.get(runId);
    if (sdkRun) {
      sdkRun.abort();
      this.sdkRuns.delete(runId);
      return true;
    }
    const child = this.processes.get(runId);
    if (!child) return false;
    terminateProcessTree(child);
    this.processes.delete(runId);
    return true;
  }

  close(): void {
    for (const controller of this.sdkRuns.values()) controller.abort();
    this.sdkRuns.clear();
    for (const child of this.processes.values()) terminateProcessTree(child);
    this.processes.clear();
  }
}
