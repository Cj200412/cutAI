import { contextBridge, ipcRenderer } from 'electron';

export interface CutaiDesktopApi {
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
}

export interface WorkspaceManifestResult {
  projectId: string;
  name: string;
  schemaVersion: number;
  updatedAt: string;
}

export interface WorkspaceMediaResult {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'image' | 'gif' | 'svg' | 'subtitle';
  relativePath: string;
  bytes: number;
  modifiedAtMs: number;
  sha256: string;
  url: string;
}

export interface WorkspaceProjectResult {
  rootPath: string;
  manifest: WorkspaceManifestResult;
  document: unknown;
  media: WorkspaceMediaResult[];
}

export interface CliAgentProfileResult {
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

export interface CliRunRequest {
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
  forkSession?: boolean;
}

export type CliStreamEvent =
  | { runId: string; type: 'status'; message: string }
  | { runId: string; type: 'thinking'; delta: string }
  | { runId: string; type: 'text'; delta: string }
  | { runId: string; type: 'model'; model: string; requestedModel?: string }
  | { runId: string; type: 'tool-start'; toolId?: string; name: string; args?: unknown }
  | { runId: string; type: 'tool-result'; toolId?: string; name: string; result?: unknown }
  | { runId: string; type: 'error'; message: string };

export interface CliRunResult {
  runId: string;
  sessionId?: string;
  text: string;
  reasoning?: string;
  usage?: Record<string, unknown>;
  exitCode: number;
  stderrTail: string;
  actualModel?: string;
}

const api: CutaiDesktopApi = {
  selectDirectory: (defaultPath) =>
    ipcRenderer.invoke('cutai:select-directory', defaultPath) as Promise<string | null>,
  chooseProjectSavePath: (name) => ipcRenderer.invoke('cutai:choose-project-save-path', name) as Promise<string | null>,
  chooseProjectOpenPath: () => ipcRenderer.invoke('cutai:choose-project-open-path') as Promise<string | null>,
  saveProject: (path, document) => ipcRenderer.invoke('cutai:save-project', path, document) as Promise<{ path: string; projectId: string }>,
  openProject: (path) => ipcRenderer.invoke('cutai:open-project', path) as Promise<{ document: unknown; projectId: string; name: string }>,
  chooseWorkspacePath: (mode) => ipcRenderer.invoke('cutai:choose-workspace-path', mode) as Promise<string | null>,
  createWorkspace: (path, document, projectId) => ipcRenderer.invoke('cutai:workspace-create', path, document, projectId) as Promise<WorkspaceProjectResult>,
  openWorkspace: (path) => ipcRenderer.invoke('cutai:workspace-open', path) as Promise<WorkspaceProjectResult>,
  saveWorkspace: (path, document) => ipcRenderer.invoke('cutai:workspace-save', path, document) as Promise<{ rootPath: string; manifest: WorkspaceManifestResult }>,
  rescanWorkspace: (path) => ipcRenderer.invoke('cutai:workspace-rescan', path) as Promise<WorkspaceMediaResult[]>,
  listCliAgents: () => ipcRenderer.invoke('cutai:cli-profiles') as Promise<CliAgentProfileResult[]>,
  authorizeCliAgent: (profileId, rootPath, fingerprint) =>
    ipcRenderer.invoke('cutai:cli-authorize', profileId, rootPath, fingerprint) as Promise<{ authorized: boolean }>,
  runCliAgent: (request) => ipcRenderer.invoke('cutai:cli-run', request) as Promise<CliRunResult>,
  onCliAgentEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, value: CliStreamEvent) => listener(value);
    ipcRenderer.on('cutai:cli-event', handler);
    return () => ipcRenderer.removeListener('cutai:cli-event', handler);
  },
  cancelCliAgent: (runId) => ipcRenderer.invoke('cutai:cli-cancel', runId) as Promise<boolean>,
  setSecret: (value, existingRef) => ipcRenderer.invoke('cutai:secret-set', value, existingRef) as Promise<string>,
  hasSecret: (ref) => ipcRenderer.invoke('cutai:secret-has', ref) as Promise<boolean>,
  deleteSecret: (ref) => ipcRenderer.invoke('cutai:secret-delete', ref) as Promise<void>,
};

contextBridge.exposeInMainWorld('cutaiDesktop', api);
