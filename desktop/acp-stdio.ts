import * as acp from '@agentclientprotocol/sdk';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { CliStreamPayload } from './cli-agent.ts';

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const CANCEL_GRACE_MS = 1_500;

export interface AcpStdioDefinition {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface AcpProbeResult {
  compatible: boolean;
  protocolVersion?: number;
  name?: string;
  version?: string;
  supportsHttpMcp: boolean;
  authMethodCount: number;
  reason?: string;
  stderrTail: string;
  latencyMs: number;
}

export interface AcpRunOptions extends AcpStdioDefinition {
  prompt: string;
  mcpUrl?: string;
  signal: AbortSignal;
  onEvent?: (event: CliStreamPayload) => void;
}

export interface AcpRunResult {
  sessionId: string;
  text: string;
  reasoning?: string;
  usage?: Record<string, unknown>;
  stderrTail: string;
  actualModel?: string;
}

interface AcpProcess {
  child: ChildProcessWithoutNullStreams;
  stream: acp.Stream;
  stderrTail: () => string;
  terminate: () => Promise<void>;
}

function abortError(message = 'ACP session cancelled'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => resolveExit());
  });
  if (process.platform === 'win32') {
    await new Promise<void>((resolveKill) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      });
      killer.once('error', () => resolveKill());
      killer.once('close', () => resolveKill());
    });
  } else {
    child.kill('SIGTERM');
  }
  await Promise.race([exited, new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000))]);
}

function lineLimited(input: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let lineBytes = 0;
  return input.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      for (const byte of chunk) {
        if (byte === 10) lineBytes = 0;
        else if (++lineBytes > MAX_LINE_BYTES) {
          controller.error(new Error('ACP protocol message exceeds 16 MiB'));
          return;
        }
      }
      controller.enqueue(chunk);
    },
  }));
}

function startProcess(definition: AcpStdioDefinition): AcpProcess {
  const child = spawn(definition.executable, definition.args, {
    cwd: definition.cwd,
    env: definition.env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-STDERR_LIMIT);
  });
  const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const rawInput = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  let termination: Promise<void> | undefined;
  return {
    child,
    stream: acp.ndJsonStream(output, lineLimited(rawInput)),
    stderrTail: () => stderr,
    terminate: () => termination ??= terminateProcessTree(child),
  };
}

function processFailure(child: ChildProcessWithoutNullStreams, stderrTail: () => string): Promise<never> {
  return new Promise((_, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(
        stderrTail().trim()
        || `ACP process exited before completing (code ${code ?? 'null'}, signal ${signal ?? 'none'})`,
      ));
    });
  });
}

async function initialize(ctx: acp.ClientContext, signal?: AbortSignal): Promise<acp.InitializeResponse> {
  const result = await ctx.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: 'CutAI', version: '0.1.6' },
  }, signal ? { cancellationSignal: signal } : undefined);
  if (result.protocolVersion !== acp.PROTOCOL_VERSION) {
    throw new Error(`ACP protocol ${result.protocolVersion} is incompatible; CutAI supports ${acp.PROTOCOL_VERSION}`);
  }
  return result;
}

function initializeWithTimeout(
  ctx: acp.ClientContext,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<acp.InitializeResponse> {
  const boundedMs = Math.min(60_000, Math.max(1_000, timeoutMs));
  const controller = new AbortController();
  const combinedSignal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;
  return new Promise((resolveInitialize, rejectInitialize) => {
    let settled = false;
    const finish = (error?: unknown, value?: acp.InitializeResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
      if (error !== undefined) rejectInitialize(error);
      else resolveInitialize(value!);
    };
    const onAbort = (): void => {
      controller.abort();
      finish(abortError());
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(new Error('ACP initialize handshake timed out'));
    }, boundedMs);
    if (externalSignal?.aborted) {
      onAbort();
      return;
    }
    externalSignal?.addEventListener('abort', onAbort, { once: true });
    void initialize(ctx, combinedSignal).then(
      (value) => finish(undefined, value),
      (error) => finish(error),
    );
  });
}

function safeClient(): acp.ClientApp {
  return acp.client({ name: 'CutAI' })
    .onRequest(acp.methods.client.session.requestPermission, () => ({
      outcome: { outcome: 'cancelled' },
    }));
}

export async function probeAcpStdio(definition: AcpStdioDefinition): Promise<AcpProbeResult> {
  if (definition.signal?.aborted) throw abortError('ACP probe cancelled');
  const startedAt = Date.now();
  const processHandle = startProcess(definition);
  try {
    const result = await Promise.race([
      safeClient().connectWith(processHandle.stream, (ctx) => initializeWithTimeout(
        ctx,
        definition.startupTimeoutMs ?? 10_000,
        definition.signal,
      )),
      processFailure(processHandle.child, processHandle.stderrTail),
    ]);
    return {
      compatible: true,
      protocolVersion: result.protocolVersion,
      name: result.agentInfo?.name,
      version: result.agentInfo?.version ?? undefined,
      supportsHttpMcp: result.agentCapabilities?.mcpCapabilities?.http === true,
      authMethodCount: result.authMethods?.length ?? 0,
      stderrTail: processHandle.stderrTail(),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (definition.signal?.aborted) throw abortError('ACP probe cancelled');
    return {
      compatible: false,
      supportsHttpMcp: false,
      authMethodCount: 0,
      reason: error instanceof Error ? error.message : String(error),
      stderrTail: processHandle.stderrTail(),
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    await processHandle.terminate();
  }
}

function textFromContent(content: acp.ContentBlock): string {
  return content.type === 'text' ? content.text : '';
}

export async function runAcpStdio(options: AcpRunOptions): Promise<AcpRunResult> {
  if (options.signal.aborted) throw abortError();
  const processHandle = startProcess(options);
  const text: string[] = [];
  const reasoning: string[] = [];
  let usage: Record<string, unknown> | undefined;
  let cancelSession: (() => Promise<void>) | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => {
    void cancelSession?.().catch(() => undefined);
    killTimer = setTimeout(() => { void processHandle.terminate(); }, CANCEL_GRACE_MS);
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await Promise.race([
      safeClient().connectWith(processHandle.stream, async (ctx) => {
        const initialized = await initializeWithTimeout(ctx, options.startupTimeoutMs ?? 10_000, options.signal);
        const mcpServers: acp.McpServer[] = [];
        if (options.mcpUrl) {
          if (initialized.agentCapabilities?.mcpCapabilities?.http !== true) {
            throw new Error('This ACP Agent does not advertise HTTP MCP support, so it cannot edit the CutAI timeline');
          }
          mcpServers.push({ type: 'http', name: 'cutai', url: options.mcpUrl, headers: [] });
        }
        return ctx.buildSession({ cwd: options.cwd, mcpServers }).withSession(async (session) => {
          cancelSession = () => ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
          // ACP turn cancellation is a session notification, not a JSON-RPC request
          // cancellation. The outer abort handler sends session/cancel first and only
          // terminates the process after a short grace period.
          const prompt = session.prompt(options.prompt);
          for (;;) {
            const message = await session.nextUpdate();
            if (message.kind === 'stop') {
              await prompt;
              return {
                sessionId: session.sessionId,
                text: text.join('').trim(),
                reasoning: reasoning.join('').trim() || undefined,
                usage,
                stderrTail: processHandle.stderrTail(),
              } satisfies AcpRunResult;
            }
            const update = message.update;
            if (update.sessionUpdate === 'agent_message_chunk') {
              const delta = textFromContent(update.content);
              if (delta) {
                text.push(delta);
                options.onEvent?.({ type: 'text', delta });
              }
            } else if (update.sessionUpdate === 'agent_thought_chunk') {
              const delta = textFromContent(update.content);
              if (delta) {
                reasoning.push(delta);
                options.onEvent?.({ type: 'thinking', delta });
              }
            } else if (update.sessionUpdate === 'tool_call') {
              options.onEvent?.({
                type: 'tool-start',
                toolId: update.toolCallId,
                name: update.name ?? update.title,
                args: update.rawInput,
              });
            } else if (update.sessionUpdate === 'tool_call_update') {
              if (update.status === 'completed' || update.status === 'failed') {
                options.onEvent?.({
                  type: 'tool-result',
                  toolId: update.toolCallId,
                  name: 'ACP tool',
                  result: update.rawOutput ?? update.content ?? update.status,
                });
              }
            } else if (update.sessionUpdate === 'usage_update') {
              usage = { used: update.used, size: update.size, cost: update.cost };
            }
          }
        });
      }),
      processFailure(processHandle.child, processHandle.stderrTail),
    ]);
    if (options.signal.aborted) throw abortError();
    return result;
  } catch (error) {
    if (options.signal.aborted) throw abortError();
    throw error;
  } finally {
    options.signal.removeEventListener('abort', onAbort);
    if (killTimer) clearTimeout(killTimer);
    await processHandle.terminate();
  }
}
