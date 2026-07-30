export {};

declare global {
  interface Window {
    cutaiDesktop?: {
      selectDirectory(defaultPath?: string): Promise<string | null>;
      chooseProjectSavePath(name: string): Promise<string | null>;
      chooseProjectOpenPath(): Promise<string | null>;
      saveProject(path: string, document: unknown): Promise<{ path: string; projectId: string }>;
      openProject(path: string): Promise<{ document: unknown; projectId: string; name: string }>;
      chooseWorkspacePath(mode: 'create' | 'open'): Promise<string | null>;
      createWorkspace(path: string, document: unknown, projectId?: string): Promise<WorkspaceProjectResult>;
      openWorkspace(path: string): Promise<WorkspaceProjectResult>;
      saveWorkspace(path: string, document: unknown): Promise<{ rootPath: string; manifest: WorkspaceManifestResult }>;
      rescanWorkspace(path: string): Promise<WorkspaceMediaResult[]>;
      listCliAgents(): Promise<CliAgentProfileResult[]>;
      authorizeCliAgent(profileId: string, rootPath: string, fingerprint: string): Promise<{ authorized: boolean }>;
      runCliAgent(request: CliRunRequest): Promise<CliRunResult>;
      onCliAgentEvent(listener: (event: CliStreamEvent) => void): () => void;
      cancelCliAgent(runId: string): Promise<boolean>;
      setSecret(value: string, existingRef?: string): Promise<string>;
      hasSecret(ref: string): Promise<boolean>;
      deleteSecret(ref: string): Promise<void>;
    };
  }

  interface WorkspaceManifestResult {
    projectId: string;
    name: string;
    schemaVersion: number;
    updatedAt: string;
  }

  interface WorkspaceMediaResult {
    id: string;
    name: string;
    kind: 'video' | 'audio' | 'image' | 'gif' | 'svg' | 'subtitle';
    relativePath: string;
    bytes: number;
    modifiedAtMs: number;
    sha256: string;
    url: string;
  }

  interface WorkspaceProjectResult {
    rootPath: string;
    manifest: WorkspaceManifestResult;
    document: unknown;
    media: WorkspaceMediaResult[];
  }

  interface CliAgentProfileResult {
    id: string;
    kind: 'claude' | 'codex' | 'custom-acp';
    name: string;
    executable: string;
    adapter: string;
    version: string;
    compatible: boolean;
    reason?: string;
    configDirectory?: string;
    fingerprint: string;
    authorizedRoots: string[];
    models: Array<{ id: string; label: string; reasoningEfforts: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>; defaultReasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }>;
    defaultModel?: string;
  }

  interface CliRunRequest {
    runId?: string;
    profileId: string;
    projectId: string;
    projectRoot: string;
    prompt: string;
    sessionId?: string;
    model?: string;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  fileAccess?: 'proposal-only' | 'workspace-write';
  planMode?: boolean;
  }

  type CliStreamEvent =
    | { runId: string; type: 'status'; message: string }
    | { runId: string; type: 'thinking'; delta: string }
    | { runId: string; type: 'text'; delta: string }
    | { runId: string; type: 'tool-start'; toolId?: string; name: string; args?: unknown }
    | { runId: string; type: 'tool-result'; toolId?: string; name: string; result?: unknown }
    | { runId: string; type: 'error'; message: string };

  interface CliRunResult {
    runId: string;
    sessionId?: string;
    text: string;
    reasoning?: string;
    usage?: Record<string, unknown>;
    exitCode: number;
    stderrTail: string;
  }
}
