import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  connectedProjectIds,
  editorStatuses,
  invokeEditorTool,
  onRegisteredToolsChanged,
  registeredTools,
  resolveProjectId,
  setTargetProject,
} from './broker.ts';
import { createExternalProject, listExternalProjects } from './projects.ts';
import {
  listWorkspaceFilesForCli,
  readWorkspaceFileForCli,
  workspaceCliGrantForToken,
  workspaceProjectIdForCliToken,
} from '../../desktop/workspace-project.ts';

export const OPENCHATCUT_SKILL_BASELINE = '2026-07-27.1';

const PROJECT_SELECTOR = {
  type: 'string',
  description: 'OpenChatCut project id. Optional when exactly one editor is connected or target_project was called.',
};

const CONTROL_TOOLS: Tool[] = [
  {
    name: 'openchatcut_status',
    description: 'Show connected OpenChatCut editors and the current MCP capability status.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_projects',
    description: 'List OpenChatCut projects, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        includeDeleted: { type: 'boolean' },
        editorBaseUrl: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'create_project',
    description: 'Create an empty OpenChatCut project with one active timeline and one video track.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        compositionWidth: { type: 'number' },
        compositionHeight: { type: 'number' },
        fps: { type: 'number' },
        editorBaseUrl: { type: 'string' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'target_project',
    description: 'Select the OpenChatCut project used by later calls that omit editorProjectId.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, editorBaseUrl: { type: 'string' } },
      required: ['projectId'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_editor_url',
    description: 'Return the OpenChatCut editor URL for a project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, editorBaseUrl: { type: 'string' } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

const CLI_WORKSPACE_TOOLS: Tool[] = [
  {
    name: 'cutai_workspace_list_files',
    description: 'List files and directories inside the authorized local CutAI workspace. .cutai metadata is hidden.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative directory path. Defaults to .' } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'cutai_workspace_read_file',
    description: 'Read a UTF-8 text file inside the authorized local CutAI workspace. Binary media and .cutai metadata are denied.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
      required: ['path'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function editorUrl(args: Record<string, unknown>, projectId: string, fallbackBase: string): string {
  const base = String(args.editorBaseUrl ?? '').trim() || fallbackBase;
  return `${base.replace(/\/+$/, '')}/#/editor/${encodeURIComponent(projectId)}`;
}

export function mcpTools(cliToken?: string): Tool[] {
  const grant = cliToken ? workspaceCliGrantForToken(cliToken) : undefined;
  const boundProjectId = grant?.projectId;
  const readOnly = grant?.mcpMode === 'read-only';
  const controls = new Set(CONTROL_TOOLS.map((tool) => tool.name));
  const editorTools = registeredTools(boundProjectId)
    .filter((tool) => !controls.has(tool.name))
    .filter((tool) => !readOnly || tool.annotations?.readOnlyHint === true)
    .map((tool): Tool => {
      const properties: Record<string, object> = {
        ...(tool.input_schema.properties as Record<string, object> | undefined),
        editorProjectId: PROJECT_SELECTOR,
      };
      if (boundProjectId && tool.name === 'begin_edit_session') {
        const current = properties.approvalMode;
        properties.approvalMode = {
          ...(current && typeof current === 'object' ? current as Record<string, unknown> : {}),
          type: 'string',
          enum: ['manual'],
          default: 'manual',
          description: 'Local CLI Agent sessions always require review in CutAI before applying edits.',
        };
      }
      return {
        name: tool.name,
        description: boundProjectId && tool.name === 'begin_edit_session'
          ? 'Start a project-bound edit draft. Local CLI Agent sessions are manual-review only.'
          : tool.description,
        annotations: tool.annotations,
        inputSchema: { ...tool.input_schema, properties },
      };
    });
  const controlTools = readOnly
    ? CONTROL_TOOLS.filter((tool) => tool.annotations?.readOnlyHint === true)
    : CONTROL_TOOLS;
  return [...controlTools, ...(cliToken ? CLI_WORKSPACE_TOOLS : []), ...editorTools];
}

async function callControlTool(
  name: string,
  args: Record<string, unknown>,
  baseUrl: string,
  cliToken?: string,
): Promise<unknown | undefined> {
  const boundProjectId = cliToken ? workspaceProjectIdForCliToken(cliToken) : undefined;
  if (name === 'cutai_workspace_list_files' && cliToken) {
    return listWorkspaceFilesForCli(cliToken, String(args.path ?? '.'));
  }
  if (name === 'cutai_workspace_read_file' && cliToken) {
    return readWorkspaceFileForCli(cliToken, String(args.path ?? ''));
  }
  if (name === 'openchatcut_status') {
    return {
      connectedProjectIds: boundProjectId
        ? connectedProjectIds().filter((projectId) => projectId === boundProjectId)
        : connectedProjectIds(),
      editors: boundProjectId
        ? editorStatuses().filter((editor) => editor.projectId === boundProjectId)
        : editorStatuses(),
      toolCount: mcpTools(cliToken).length,
      ...(boundProjectId ? { boundProjectId } : {}),
    };
  }
  if (name === 'list_projects') {
    const projects = await listExternalProjects(args.includeDeleted === true);
    return projects.filter((project) => !boundProjectId || project.id === boundProjectId).map((project) => ({
      ...project,
      editorUrl: editorUrl(args, project.id, baseUrl),
    }));
  }
  if (name === 'create_project') {
    if (boundProjectId) throw new Error('This CLI MCP session is bound to an existing CutAI project');
    const project = await createExternalProject(args);
    setTargetProject(project.id);
    return { ...project, editorUrl: editorUrl(args, project.id, baseUrl) };
  }
  if (name === 'target_project') {
    const requested = String(args.projectId ?? '').trim();
    const projectId = boundProjectId ?? requested;
    if (!projectId) throw new Error('projectId is required');
    if (boundProjectId && requested !== boundProjectId) {
      throw new Error(`This CLI MCP session is bound to project ${boundProjectId}`);
    }
    if (!boundProjectId) setTargetProject(projectId);
    return { ok: true, projectId, editorUrl: editorUrl(args, projectId, baseUrl) };
  }
  if (name === 'get_editor_url') {
    const requested = String(args.projectId ?? '').trim();
    if (boundProjectId && requested && requested !== boundProjectId) {
      throw new Error(`This CLI MCP session is bound to project ${boundProjectId}`);
    }
    const projectId = boundProjectId ?? resolveProjectId(args.projectId);
    return { projectId, editorUrl: editorUrl(args, projectId, baseUrl) };
  }
  return undefined;
}

async function callTool(
  name: string,
  rawArgs: unknown,
  baseUrl: string,
  cliToken?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const args = rawArgs && typeof rawArgs === 'object'
    ? { ...(rawArgs as Record<string, unknown>) }
    : {};
  const grant = cliToken ? workspaceCliGrantForToken(cliToken) : undefined;
  if (grant?.mcpMode === 'read-only' && !mcpTools(cliToken).some((tool) => tool.name === name)) {
    throw new Error('This CLI Agent plan session is read-only; edit-session and mutating tools are unavailable');
  }
  if (grant?.mcpMode === 'manual-edit' && name === 'begin_edit_session') {
    if (args.approvalMode === 'auto') {
      throw new Error('Local CLI Agent edits require approvalMode manual and user review in CutAI');
    }
    if (args.approvalMode === undefined) args.approvalMode = 'manual';
    // Predetermine the isolated draft id before dispatch. If the CLI run is
    // cancelled while begin_edit_session is executing, the broker can enqueue
    // an idempotent discard without waiting for the begin result to come back.
    args.editSessionId = randomUUID();
  }
  const control = await callControlTool(name, args, baseUrl, cliToken);
  if (control !== undefined) return control;
  const boundProjectId = cliToken ? workspaceProjectIdForCliToken(cliToken) : undefined;
  const requestedProjectId = typeof args.editorProjectId === 'string'
    ? args.editorProjectId.trim()
    : '';
  if (boundProjectId && requestedProjectId && requestedProjectId !== boundProjectId) {
    throw new Error(`This CLI MCP session is bound to project ${boundProjectId}`);
  }
  const projectId = boundProjectId ?? resolveProjectId(args.editorProjectId);
  delete args.editorProjectId;
  if ((name === 'track_progress' || name === 'track_export') && args.action === 'wait') {
    const requested = Number(args.timeoutSeconds);
    args.timeoutSeconds = Math.min(45, requested > 0 ? requested : 45);
  }
  return invokeEditorTool(projectId, name, args, {
    signal,
    ...(cliToken ? { ownerId: cliToken } : {}),
  });
}

function makeServer(baseUrl: string, cliToken?: string): Server {
  const cliMode = cliToken ? workspaceCliGrantForToken(cliToken).mcpMode : undefined;
  const sessionInstructions = cliMode === 'read-only'
    ? [
        'This project-bound local CLI plan session is read-only. Inspect with read-only tools; edit sessions and mutating tools are unavailable.',
      ]
    : cliToken
    ? [
        'This project-bound local CLI edit session is manual-review only. Call begin_edit_session with approvalMode manual, then pass its editSessionId to every editor tool.',
        'Call review_edit_session when the draft is ready. The draft waits for approval in OpenChatCut; do not claim success until status is applied.',
      ]
    : [
        'Call begin_edit_session first with approvalMode manual (default) or auto, then pass its editSessionId to every editor tool.',
        'Call review_edit_session when the draft is ready.',
        'Manual sessions wait for approval in OpenChatCut; auto sessions apply the complete draft during review_edit_session. Do not claim success until status is applied.',
        'If an auto session becomes stale, discard it and begin a new session.',
      ];
  const server = new Server(
    { name: 'openchatcut', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      instructions: [
        `OpenChatCut external skill baseline: ${OPENCHATCUT_SKILL_BASELINE}. Update with npx skills update openchatcut when the installed skill is older.`,
        'OpenChatCut project edits are session-scoped.',
        ...sessionInstructions,
      ].join(' '),
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools(cliToken) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const result = await callTool(
        request.params.name,
        request.params.arguments,
        baseUrl,
        cliToken,
        extra.signal,
      );
      return {
        content: toMcpContent(result),
        structuredContent: toStructuredContent(result),
      };
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: error instanceof Error ? error.message : String(error),
        }],
      };
    }
  });
  return server;
}

interface McpSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
}

const sessions = new Map<string, McpSession>();

onRegisteredToolsChanged(() => {
  for (const { server } of sessions.values()) {
    void server.sendToolListChanged().catch(() => undefined);
  }
});

function sessionIdOf(req: IncomingMessage): string | null {
  const value = req.headers['mcp-session-id'];
  return typeof value === 'string' && value ? value : null;
}

function sendSessionError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: status === 404 ? -32001 : -32000, message },
    id: null,
  }));
}

async function startMcpSession(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
): Promise<void> {
  let session: McpSession;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized: (sessionId) => { sessions.set(sessionId, session); },
  });
  const requestUrl = new URL(req.url ?? '/', baseUrl);
  const cliToken = requestUrl.searchParams.get('cutaiCliToken') || undefined;
  const server = makeServer(baseUrl, cliToken);
  session = { server, transport };
  transport.onclose = () => {
    const sessionId = transport.sessionId;
    if (sessionId) sessions.delete(sessionId);
  };
  await server.connect(transport);
  await transport.handleRequest(req, res);
  if (!transport.sessionId) await server.close();
}

interface EmbeddedImage {
  base64: string;
  frame?: number;
  mimeType?: string;
}

function embeddedImages(result: unknown): EmbeddedImage[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const images = (result as { __images?: unknown }).__images;
  if (!Array.isArray(images)) return [];
  return images.filter((image): image is EmbeddedImage => (
    Boolean(image)
    && typeof image === 'object'
    && typeof (image as EmbeddedImage).base64 === 'string'
  ));
}

export function toStructuredContent(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { result };
  const record = result as Record<string, unknown>;
  const images = embeddedImages(record);
  if (!images.length) return record;
  const { __images: _images, ...rest } = record;
  return {
    ...rest,
    images: images.map((image) => ({
      frame: image.frame,
      mimeType: image.mimeType ?? 'image/jpeg',
    })),
  };
}

export function toMcpContent(result: unknown): CallToolResult['content'] {
  const structured = toStructuredContent(result);
  return [
    { type: 'text', text: JSON.stringify(structured) },
    ...embeddedImages(result).map((image) => ({
      type: 'image' as const,
      data: image.base64,
      mimeType: image.mimeType ?? 'image/jpeg',
    })),
  ];
}

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
): Promise<void> {
  const sessionId = sessionIdOf(req);
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
      sendSessionError(res, 404, 'MCP session not found');
      return;
    }
    await session.transport.handleRequest(req, res);
    return;
  }
  if (req.method !== 'POST') {
    sendSessionError(res, 400, 'MCP session id is required');
    return;
  }
  await startMcpSession(req, res, baseUrl);
}
