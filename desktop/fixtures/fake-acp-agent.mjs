import * as acp from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';

const mode = process.argv[2] || 'normal';
const markerPath = process.argv[3];
const sessions = new Map();

function mark(value) {
  if (markerPath) appendFileSync(markerPath, `${value}\n`, 'utf8');
}

if (mode === 'mark-start') mark('process-started');

const application = acp.agent({ name: 'cutai-fake-agent' })
  .onRequest(acp.methods.agent.initialize, async () => {
    if (mode === 'hang-initialize') await new Promise(() => undefined);
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: 'CutAI Fake ACP', version: '1.0.0' },
      agentCapabilities: {
        loadSession: false,
        mcpCapabilities: mode === 'no-http' ? {} : { http: true },
      },
    };
  })
  .onRequest(acp.methods.agent.session.new, ({ params }) => {
    const sessionId = randomUUID();
    sessions.set(sessionId, new AbortController());
    if (mode === 'expect-mcp' && !params.mcpServers.some((server) => server.type === 'http' && server.name === 'cutai')) {
      throw new Error('expected CutAI HTTP MCP server');
    }
    return { sessionId };
  })
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const controller = sessions.get(params.sessionId);
    if (!controller) throw new Error('unknown session');
    if (mode === 'wait-cancel') {
      mark('prompt-started');
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 30_000);
        controller.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      return { stopReason: controller.signal.aborted ? 'cancelled' : 'end_turn' };
    }
    if (mode === 'report-env') {
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: JSON.stringify({
              allowed: process.env.CUTAI_TEST_ALLOWED_ENV ?? null,
              proxyPresent: Boolean(process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY),
            }),
          },
        },
      });
      return { stopReason: 'end_turn' };
    }
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: '检查中。' },
      },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: '读取时间线',
        name: 'cutai.read_timeline',
        status: 'in_progress',
        rawInput: { project: '测试' },
      },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        rawOutput: { ok: true },
      },
    });
    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: { toolCallId: 'permission-1', title: '写入工程', status: 'pending' },
      options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }],
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: permission.outcome.outcome === 'cancelled' ? '你好，权限已拒绝。' : '权限错误。',
        },
      },
    });
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'usage_update', used: 12, size: 4096 },
    });
    return { stopReason: 'end_turn' };
  })
  .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
    mark('cancel-received');
    sessions.get(params.sessionId)?.abort();
  });

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
application.connect(acp.ndJsonStream(output, input));
