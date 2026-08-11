import type { CliAgentKind } from './cli-agent.ts';

/** Minimal execution + provider environment for a local CLI; unrelated host secrets are omitted. */
export function cliAgentRuntimeEnv(kind: CliAgentKind): NodeJS.ProcessEnv {
  const allowed = [
    'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
    'TEMP', 'TMP', 'LANG', 'LC_ALL', 'PATH', 'Path', 'PATHEXT', 'ComSpec',
    'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ];
  if (kind === 'claude') {
    allowed.push(
      'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    );
  }
  if (kind === 'codex') {
    allowed.push('CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL');
  }
  return Object.fromEntries(allowed.flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []));
}
