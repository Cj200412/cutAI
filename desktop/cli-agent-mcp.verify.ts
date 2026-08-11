import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliAgentRuntimeEnv } from './cli-agent-env.ts';
import { claudeMcpServers, cliAgentMcpUrl, codexMcpConfig } from './cli-agent-mcp.ts';
import {
  issueWorkspaceCliToken,
  listWorkspaceFilesForCli,
  registerWorkspaceRoot,
  revokeWorkspaceCliToken,
  workspaceCliGrantForToken,
  workspaceProjectMatchesRoot,
} from './workspace-project.ts';

const url = cliAgentMcpUrl('http://127.0.0.1:4173/', 'token with spaces');
assert.equal(url, 'http://127.0.0.1:4173/api/external-mcp/mcp?cutaiCliToken=token%20with%20spaces');
assert.deepEqual(codexMcpConfig({ url }), { mcp_servers: { cutai: { url } } });
assert.deepEqual(claudeMcpServers({ url }), { cutai: { type: 'http', url } });

const previousEnv = {
  secret: process.env.SECRET_SHOULD_NOT_LEAK,
  anthropicToken: process.env.ANTHROPIC_AUTH_TOKEN,
  anthropicBase: process.env.ANTHROPIC_BASE_URL,
  openaiKey: process.env.OPENAI_API_KEY,
};
try {
  process.env.SECRET_SHOULD_NOT_LEAK = 'hidden';
  process.env.ANTHROPIC_AUTH_TOKEN = 'claude-provider-token';
  process.env.ANTHROPIC_BASE_URL = 'https://claude.example.test';
  process.env.OPENAI_API_KEY = 'codex-provider-token';
  assert.equal(cliAgentRuntimeEnv('codex').SECRET_SHOULD_NOT_LEAK, undefined,
    'the CLI environment uses an allowlist instead of copying unrelated host secrets');
  assert.equal(cliAgentRuntimeEnv('claude').ANTHROPIC_AUTH_TOKEN, 'claude-provider-token');
  assert.equal(cliAgentRuntimeEnv('claude').ANTHROPIC_BASE_URL, 'https://claude.example.test');
  assert.equal(cliAgentRuntimeEnv('codex').OPENAI_API_KEY, 'codex-provider-token');
  assert.equal(cliAgentRuntimeEnv('codex').ANTHROPIC_AUTH_TOKEN, undefined,
    'provider credentials are only exposed to their matching CLI');
} finally {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore('SECRET_SHOULD_NOT_LEAK', previousEnv.secret);
  restore('ANTHROPIC_AUTH_TOKEN', previousEnv.anthropicToken);
  restore('ANTHROPIC_BASE_URL', previousEnv.anthropicBase);
  restore('OPENAI_API_KEY', previousEnv.openaiKey);
}

const root = await mkdtemp(join(tmpdir(), 'cutai-cli-mcp-'));
try {
  await mkdir(join(root, '.cutai'), { recursive: true });
  registerWorkspaceRoot('cli-mcp-project', root);
  assert.equal(workspaceProjectMatchesRoot('cli-mcp-project', root), true);
  assert.equal(workspaceProjectMatchesRoot('different-project', root), false,
    'a CLI request cannot pair an authorized root with another open project id');
  const token = issueWorkspaceCliToken('cli-mcp-project');
  assert.deepEqual(workspaceCliGrantForToken(token), {
    projectId: 'cli-mcp-project',
    mcpMode: 'manual-edit',
  });
  const planToken = issueWorkspaceCliToken('cli-mcp-project', { mcpMode: 'read-only' });
  assert.equal(workspaceCliGrantForToken(planToken).mcpMode, 'read-only');
  revokeWorkspaceCliToken(planToken);
  const listed = await listWorkspaceFilesForCli(token) as { entries?: unknown };
  assert.ok(Array.isArray(listed.entries));
  revokeWorkspaceCliToken(token);
  await assert.rejects(listWorkspaceFilesForCli(token), /invalid or expired/,
    'run-scoped workspace tokens are revoked after the CLI turn');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('cli-agent-mcp.verify: ok');
