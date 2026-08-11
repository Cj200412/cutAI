import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  issueWorkspaceCliToken,
  registerWorkspaceRoot,
  revokeWorkspaceCliToken,
} from '../../desktop/workspace-project.ts';
import { externalAgentRequestAuthorized } from '../plugins/external-agent.ts';
import {
  isProjectConnected,
  nextEditorCall,
  registerEditor,
  releaseEditorOwner,
  settleEditorCall,
} from './broker.ts';
import { handleMcpRequest } from './mcp.ts';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

const projectA = 'cli-bound-project-a';
const projectB = 'cli-bound-project-b';
const rootA = await mkdtemp(join(tmpdir(), 'cutai-bound-a-'));
const rootB = await mkdtemp(join(tmpdir(), 'cutai-bound-b-'));
await mkdir(join(rootA, '.cutai'), { recursive: true });
await mkdir(join(rootB, '.cutai'), { recursive: true });
registerWorkspaceRoot(projectA, rootA);
registerWorkspaceRoot(projectB, rootB);
registerEditor(projectA, 'editor-a', [
  {
    name: 'begin_edit_session',
    annotations: { readOnlyHint: false },
    input_schema: {
      type: 'object',
      properties: { approvalMode: { type: 'string', enum: ['manual', 'auto'] } },
    },
  },
  {
    name: 'bound_project_a_check',
    annotations: { readOnlyHint: true },
    input_schema: { type: 'object', properties: {} },
  },
]);
registerEditor(projectB, 'editor-b', [{
  name: 'bound_project_b_check',
  input_schema: { type: 'object', properties: {} },
}]);

const cliToken = issueWorkspaceCliToken(projectA);
const planToken = issueWorkspaceCliToken(projectA, { mcpMode: 'read-only' });
const previousGlobalToken = process.env.OPENCHATCUT_MCP_TOKEN;
process.env.OPENCHATCUT_MCP_TOKEN = 'global-mcp-secret';
try {
  assert.equal(externalAgentRequestAuthorized({
    url: `/mcp?cutaiCliToken=${encodeURIComponent(cliToken)}`,
    headers: {},
  } as IncomingMessage), true, 'a valid project CLI token authenticates the internal MCP connection');
  assert.equal(externalAgentRequestAuthorized({
    url: '/mcp?cutaiCliToken=invalid',
    headers: {},
  } as IncomingMessage), false, 'an invalid CLI token cannot bypass the configured global bearer token');
  assert.equal(externalAgentRequestAuthorized({
    url: '/mcp',
    headers: { authorization: 'Bearer global-mcp-secret' },
  } as IncomingMessage), true, 'the existing external bearer-token path remains supported');
} finally {
  if (previousGlobalToken === undefined) delete process.env.OPENCHATCUT_MCP_TOKEN;
  else process.env.OPENCHATCUT_MCP_TOKEN = previousGlobalToken;
}

const server = createServer((req, res) => {
  void handleMcpRequest(req, res, 'http://127.0.0.1').catch((error) => {
    if (!res.headersSent) res.writeHead(500);
    res.end(error instanceof Error ? error.message : String(error));
  });
});
const port = await listen(server);
const client = new Client({ name: 'cutai-cli-bound-check', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(
  `http://127.0.0.1:${port}/mcp?cutaiCliToken=${encodeURIComponent(cliToken)}`,
));
const planClient = new Client({ name: 'cutai-cli-plan-check', version: '1.0.0' });
const planTransport = new StreamableHTTPClientTransport(new URL(
  `http://127.0.0.1:${port}/mcp?cutaiCliToken=${encodeURIComponent(planToken)}`,
));

try {
  await client.connect(transport);
  await planClient.connect(planTransport);
  const listedTools = (await client.listTools()).tools;
  const tools = listedTools.map((tool) => tool.name);
  assert.ok(tools.includes('bound_project_a_check'));
  assert.ok(!tools.includes('bound_project_b_check'), 'tool schemas come from the token-bound editor only');
  const beginSchema = listedTools.find((tool) => tool.name === 'begin_edit_session')?.inputSchema
    .properties?.approvalMode as { enum?: unknown } | undefined;
  assert.deepEqual(beginSchema?.enum, ['manual'], 'CLI MCP advertises only manual review');

  const status = await client.callTool({ name: 'openchatcut_status', arguments: {} });
  const statusBody = status.structuredContent as { connectedProjectIds?: unknown; boundProjectId?: unknown };
  assert.deepEqual(statusBody.connectedProjectIds, [projectA]);
  assert.equal(statusBody.boundProjectId, projectA);

  const targetOther = await client.callTool({ name: 'target_project', arguments: { projectId: projectB } });
  assert.equal(targetOther.isError, true, 'a tokenized session cannot retarget another project');
  const editOther = await client.callTool({
    name: 'bound_project_a_check',
    arguments: { editorProjectId: projectB },
  });
  assert.equal(editOther.isError, true, 'editorProjectId cannot override the token-bound project');
  const createOther = await client.callTool({ name: 'create_project', arguments: { name: 'not allowed' } });
  assert.equal(createOther.isError, true, 'a project-bound CLI session cannot create or switch projects');

  const autoSession = await client.callTool({
    name: 'begin_edit_session',
    arguments: { approvalMode: 'auto' },
  });
  assert.equal(autoSession.isError, true, 'a CLI cannot bypass the CutAI proposal UI with auto review');
  const manualSessionPromise = client.callTool({
    name: 'begin_edit_session',
    arguments: {},
  });
  const manualQueued = await nextEditorCall(projectA, 'editor-a', AbortSignal.timeout(2_000));
  assert.equal(manualQueued?.name, 'begin_edit_session');
  assert.equal(manualQueued?.arguments.approvalMode, 'manual', 'omitted CLI approval mode is forced to manual');
  assert.match(
    String(manualQueued?.arguments.editSessionId),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'the server predetermines the isolated draft id before dispatch',
  );
  assert.equal(settleEditorCall(manualQueued!.id, true, {
    approvalMode: 'manual',
    editSessionId: manualQueued!.arguments.editSessionId,
  }), true);
  assert.equal((await manualSessionPromise).isError, undefined);

  const validCallPromise = client.callTool({ name: 'bound_project_a_check', arguments: { value: 7 } });
  const queued = await nextEditorCall(projectA, 'editor-a', AbortSignal.timeout(2_000));
  assert.equal(queued?.name, 'bound_project_a_check');
  assert.equal(settleEditorCall(queued!.id, true, { projectId: projectA }), true);
  const validResult = await validCallPromise;
  assert.equal(validResult.isError, undefined);
  assert.equal((validResult.structuredContent as { projectId?: unknown }).projectId, projectA);

  const callAbort = new AbortController();
  const abortedCallPromise = client.callTool(
    { name: 'bound_project_a_check', arguments: { cancellationProbe: true } },
    undefined,
    { signal: callAbort.signal },
  );
  const abortedCall = await nextEditorCall(projectA, 'editor-a', AbortSignal.timeout(2_000));
  assert.equal(abortedCall?.name, 'bound_project_a_check');
  callAbort.abort();
  await assert.rejects(
    abortedCallPromise,
    (error: unknown) => error instanceof Error && /AbortError|aborted/i.test(`${error.name}: ${error.message}`),
  );
  for (let attempt = 0; attempt < 20 && isProjectConnected(projectA, Date.now() + 60_000); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    isProjectConnected(projectA, Date.now() + 60_000),
    false,
    'MCP RequestHandlerExtra.signal cancels the dispatched broker call instead of leaving it active',
  );
  assert.equal(settleEditorCall(abortedCall!.id, true, { late: true }), true);

  const planTools = (await planClient.listTools()).tools.map((tool) => tool.name);
  assert.ok(planTools.includes('openchatcut_status'));
  assert.ok(planTools.includes('bound_project_a_check'));
  assert.ok(!planTools.includes('begin_edit_session'), 'plan mode does not advertise edit sessions');
  assert.ok(!planTools.includes('create_project'), 'plan mode does not advertise mutating controls');
  const blockedPlanEdit = await planClient.callTool({
    name: 'begin_edit_session',
    arguments: { approvalMode: 'manual' },
  });
  assert.equal(blockedPlanEdit.isError, true, 'calling an unlisted mutating tool is also rejected server-side');
  const planReadPromise = planClient.callTool({ name: 'bound_project_a_check', arguments: {} });
  const planRead = await nextEditorCall(projectA, 'editor-a', AbortSignal.timeout(2_000));
  assert.equal(planRead?.name, 'bound_project_a_check');
  assert.equal(settleEditorCall(planRead!.id, true, { readOnly: true }), true);
  assert.equal((await planReadPromise).isError, undefined);
} finally {
  await client.close();
  await planClient.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  releaseEditorOwner(cliToken);
  releaseEditorOwner(planToken);
  revokeWorkspaceCliToken(cliToken);
  revokeWorkspaceCliToken(planToken);
  await rm(rootA, { recursive: true, force: true });
  await rm(rootB, { recursive: true, force: true });
}

console.log('cli-bound-mcp.verify: ok (auth, project binding, manual review, read-only plan mode)');
