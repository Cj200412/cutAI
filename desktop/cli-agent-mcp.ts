export interface CliAgentMcpContext {
  url: string;
}

export function cliAgentMcpUrl(origin: string, token: string): string {
  const base = origin.replace(/\/$/, '');
  return `${base}/api/external-mcp/mcp?cutaiCliToken=${encodeURIComponent(token)}`;
}

export function codexMcpConfig(context: CliAgentMcpContext) {
  return { mcp_servers: { cutai: { url: context.url } } };
}

export function claudeMcpServers(context: CliAgentMcpContext) {
  return { cutai: { type: 'http' as const, url: context.url } };
}
