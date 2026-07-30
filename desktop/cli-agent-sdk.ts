import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex, type ThreadItem } from '@openai/codex-sdk';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const ffmpegStatic = createRequire(import.meta.url)('ffmpeg-static') as string | null;
import { CUTAI_AGENT_SYSTEM_PROMPT, ensureCutaiAgentGuides } from './cli-agent-guidance.ts';
import type {
  CliAgentProfile,
  CliRunRequest,
  CliRunResult,
  CliStreamEvent,
  CliStreamPayload,
} from './cli-agent.ts';

type Emit = (event: CliStreamPayload) => void;

async function prepareVisualEvidence(projectRoot: string): Promise<string | undefined> {
  if (!ffmpegStatic) return undefined;
  let project: { assets?: Array<{ src?: string; kind?: string }> };
  try { project = JSON.parse(await readFile(join(projectRoot, '.cutai', 'project.json'), 'utf8')) as typeof project; } catch { return undefined; }
  const asset = project.assets?.find((item) => item.kind === 'video' && typeof item.src === 'string');
  if (!asset?.src) return undefined;
  const source = asset.src.startsWith('/media/uploads/')
    ? resolve(process.cwd(), 'public', asset.src.slice(1))
    : resolve(projectRoot, asset.src);
  if (!existsSync(source)) return undefined;
  const dir = join(projectRoot, '.cutai', 'agent-guides');
  const output = join(dir, 'source-preview.jpg');
  await mkdir(dir, { recursive: true });
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(ffmpegStatic as string, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', source, '-frames:v', '1', '-vf', 'scale=1280:-2', output]);
    let error = ''; child.stderr?.on('data', (chunk: Buffer) => { error += String(chunk); });
    child.on('error', reject); child.on('close', (code) => code === 0 ? resolvePromise() : reject(new Error(error || `ffmpeg exited ${code}`)));
  }).catch(() => undefined);
  return existsSync(output) ? output : undefined;
}

class StreamEventBatcher {
  private readonly queued: Array<{ type: 'text' | 'thinking'; delta: string }> = [];
  private readonly emit: Emit;
  private timer: NodeJS.Timeout | undefined;

  constructor(emit: Emit) {
    this.emit = emit;
  }

  push(type: 'text' | 'thinking', delta: string): void {
    if (!delta) return;
    const tail = this.queued[this.queued.length - 1];
    if (tail?.type === type) tail.delta += delta;
    else this.queued.push({ type, delta });
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 32);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const event of this.queued.splice(0)) this.emit(event);
  }

  close(): void {
    this.flush();
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function claudeInstruction(request: CliRunRequest): string {
  const directEdit = request.fileAccess === 'workspace-write' && request.planMode !== true;
  const mode = request.planMode
    ? 'Plan mode is enabled: inspect and explain the proposed changes first; do not write files or modify the project until the user confirms.'
    : directEdit
    ? [
        'The user enabled direct workspace editing.',
        'Use Claude Code built-in file tools only inside the project root; do not use MCP or ChatCut tools.',
        'The live CutAI document is .cutai/project.json. For timeline or project edits, update that file and keep it valid JSON; CutAI will validate and synchronize it into the open editor after this turn.',
        'Do not read .cutai/sessions, .cutai/audit, project.json.bak, or unrelated history to infer the requested edit.',
        'Never modify source media or access paths outside the project root.',
      ].join(' ')
    : 'Use native SDK tools with read-only project access. Do not modify .cutai files, source media, or other project files.';
  return `${request.prompt}\n\nCutAI project id: ${request.projectId}. ${mode}`;
}

function emitToolItem(item: ThreadItem, phase: 'start' | 'result', emit: Emit): void {
  if (item.type === 'agent_message' || item.type === 'reasoning') return;
  const row = item as unknown as Record<string, unknown>;
  const name = item.type === 'mcp_tool_call'
    ? `${item.server}.${item.tool}`
    : item.type;
  if (phase === 'start') {
    emit({
      type: 'tool-start',
      toolId: item.id,
      name,
      args: row.command ?? row.arguments ?? row.query ?? row.changes ?? row.items,
    });
  } else {
    emit({
      type: 'tool-result',
      toolId: item.id,
      name,
      result: row.aggregated_output ?? row.result ?? row.error ?? row.status ?? row.items,
    });
  }
}

export async function runCodexSdk(
  profile: CliAgentProfile,
  request: CliRunRequest,
  runId: string,
  controller: AbortController,
  onEvent?: (event: CliStreamEvent) => void,
): Promise<CliRunResult> {
  const emit: Emit = (event) => onEvent?.({ runId, ...event });
  const visualEvidence = await prepareVisualEvidence(request.projectRoot);
  const codex = new Codex({
    codexPathOverride: profile.executable,
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  });
  const threadOptions = {
    workingDirectory: request.projectRoot,
    skipGitRepoCheck: true,
    approvalPolicy: 'never' as const,
    sandboxMode: request.fileAccess === 'workspace-write' && request.planMode !== true ? 'danger-full-access' as const : 'read-only' as const,
    ...(request.model ? { model: request.model } : {}),
    ...(request.reasoningEffort && request.reasoningEffort !== 'max'
      ? { modelReasoningEffort: request.reasoningEffort }
      : request.reasoningEffort === 'max' ? { modelReasoningEffort: 'xhigh' as const } : {}),
  };
  const thread = request.sessionId
    ? codex.resumeThread(request.sessionId, threadOptions)
    : codex.startThread(threadOptions);
  const text: string[] = [];
  const reasoning: string[] = [];
  let usage: Record<string, unknown> | undefined;
  let sessionId = request.sessionId;
  emit({ type: 'status', message: `${profile.name} SDK 已启动，正在建立原生流式会话…` });
  const { events } = await thread.runStreamed(`${claudeInstruction(request)}${visualEvidence ? `\n\nA local source preview is available at ${visualEvidence}; inspect it before making visual claims.` : ''}`, { signal: controller.signal });
  for await (const event of events) {
    if (event.type === 'thread.started') {
      sessionId = event.thread_id;
    } else if (event.type === 'item.started') {
      emitToolItem(event.item, 'start', emit);
    } else if (event.type === 'item.completed') {
      if (event.item.type === 'agent_message') {
        text.push(event.item.text);
        emit({ type: 'text', delta: event.item.text });
      } else if (event.item.type === 'reasoning') {
        reasoning.push(event.item.text);
        emit({ type: 'thinking', delta: event.item.text });
      } else {
        emitToolItem(event.item, 'result', emit);
      }
    } else if (event.type === 'turn.completed') {
      usage = event.usage as unknown as Record<string, unknown>;
    } else if (event.type === 'turn.failed') {
      throw new Error(event.error.message);
    } else if (event.type === 'error') {
      throw new Error(event.message);
    }
  }
  emit({ type: 'status', message: 'Codex SDK 会话已完成' });
  return {
    runId,
    sessionId: sessionId ?? thread.id ?? undefined,
    text: text.join('\n\n').trim(),
    reasoning: reasoning.join('\n').trim() || undefined,
    usage,
    exitCode: 0,
    stderrTail: '',
  };
}

export async function runClaudeSdk(
  profile: CliAgentProfile,
  request: CliRunRequest,
  runId: string,
  controller: AbortController,
  onEvent?: (event: CliStreamEvent) => void,
): Promise<CliRunResult> {
  await ensureCutaiAgentGuides(request.projectRoot);
  const visualEvidence = await prepareVisualEvidence(request.projectRoot);
  const emit: Emit = (event) => onEvent?.({ runId, ...event });
  const directEdit = request.fileAccess === 'workspace-write' && request.planMode !== true;
  const text: string[] = [];
  const reasoning: string[] = [];
  let streamedText = false;
  let streamedThinking = false;
  let sessionId = request.sessionId;
  let usage: Record<string, unknown> | undefined;
  let actualModel: string | undefined;
  emit({ type: 'status', message: `${profile.name} Agent SDK 已启动，正在建立原生流式会话…` });
  const batcher = new StreamEventBatcher(emit);
  const promptText = `${claudeInstruction(request)}${visualEvidence ? `\n\nA local source preview was extracted for visual inspection at ${visualEvidence}. Read that image before making visual claims.` : ''}`;
  const stream = query({
    prompt: promptText,
    options: {
      cwd: request.projectRoot,
      pathToClaudeCodeExecutable: profile.executable,
      abortController: controller,
      includePartialMessages: true,
      // Keep the user's Claude login/runtime preferences, but exclude project
      // and local settings. strictMcpConfig below still blocks every inherited MCP.
      settingSources: ['user'],
      strictMcpConfig: true,
      mcpServers: {},
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: CUTAI_AGENT_SYSTEM_PROMPT,
      },
      permissionMode: request.planMode ? 'plan' : directEdit ? 'bypassPermissions' : 'dontAsk',
      ...(directEdit ? {
        allowDangerouslySkipPermissions: true,
        tools: { type: 'preset' as const, preset: 'claude_code' as const },
        disallowedTools: ['Bash'],
      } : {
        tools: ['Read', 'Glob', 'Grep'],
      }),
      ...(request.sessionId ? { resume: request.sessionId } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
    },
  });
  try {
    for await (const message of stream) {
      sessionId = message.session_id || sessionId;
      if (message.type === 'system' && message.subtype === 'init') {
        actualModel = message.model;
        emit({ type: 'status', message: `${profile.name} 实际模型：${message.model}` });
      }
      if (message.type === 'stream_event') {
        if (message.parent_tool_use_id) continue;
        const event = record(message.event);
        const delta = record(event?.delta);
        if (event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
          streamedText = true;
          batcher.push('text', delta.text);
        } else if (event?.type === 'content_block_delta' && delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          streamedThinking = true;
          batcher.push('thinking', delta.thinking);
        }
        continue;
      }
      batcher.flush();
      if (message.type === 'assistant') {
        let messageStreamedText = false;
        let messageStreamedThinking = false;
        for (const part of message.message.content) {
          if (part.type === 'text') {
            text.push(part.text);
            messageStreamedText = streamedText;
            if (!messageStreamedText) emit({ type: 'text', delta: part.text });
          } else if (part.type === 'thinking') {
            reasoning.push(part.thinking);
            messageStreamedThinking = streamedThinking;
            if (!messageStreamedThinking) emit({ type: 'thinking', delta: part.thinking });
          } else if (part.type === 'tool_use') {
            emit({ type: 'tool-start', toolId: part.id, name: part.name, args: part.input });
          }
        }
        streamedText = false;
        streamedThinking = false;
      } else if (message.type === 'user') {
        const body = record(message.message);
        const content = Array.isArray(body?.content) ? body.content : [];
        for (const rawPart of content) {
          const part = record(rawPart);
          if (part?.type === 'tool_result') {
            emit({
              type: 'tool-result',
              ...(typeof part.tool_use_id === 'string' ? { toolId: part.tool_use_id } : {}),
              name: 'tool',
              result: part.content,
            });
          }
        }
      } else if (message.type === 'result') {
        usage = message.usage as unknown as Record<string, unknown>;
        if (message.subtype === 'success') {
          if (!text.length && message.result) {
            text.push(message.result);
            if (!streamedText) emit({ type: 'text', delta: message.result });
          }
        } else {
          throw new Error(message.errors.join('\n') || message.subtype);
        }
      }
    }
  } finally {
    batcher.close();
    stream.close();
  }
  emit({ type: 'status', message: 'Claude Agent SDK 会话已完成' });
  return {
    runId,
    sessionId,
    text: [...new Set(text)].join('\n\n').trim(),
    reasoning: reasoning.join('\n').trim() || undefined,
    usage,
    exitCode: 0,
    stderrTail: '',
    actualModel,
  };
}
