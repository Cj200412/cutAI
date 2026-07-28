import './chdir-first.ts';
import { rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, type OpenDialogOptions } from 'electron';
import { startEmbeddedServer } from './embedded-server.ts';
import { preparePackagedRuntime } from './packaged-runtime.ts';
import { cutaiProjectDisplayName, loadCutaiProject, saveCutaiProject } from './cutai-project.ts';
import { CutaiSecretStore } from './secret-store.ts';
import { bootstrapLocalLlmProxy } from './llm-proxy-bootstrap.ts';
import {
  createWorkspaceProject,
  openWorkspaceProject,
  rescanWorkspace,
  saveWorkspaceProject,
} from './workspace-project.ts';
import { CliAgentHost, type CliRunRequest } from './cli-agent.ts';

// Electron 主进程入口。dev 形态:esbuild 打到 desktop-dist/main.mjs,dist/ 在仓库根;
// 打包形态:dist/、remotion-bundle、chrome-headless-shell 走 extraResources。
const DIST_DIR = app.isPackaged
  ? join(process.resourcesPath, 'dist')
  : join(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const PRELOAD_PATH = join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs');

// CC_SMOKE=1:无窗冒烟——起内嵌 server、加载页面、探 /api/keys,按结果退码 0/1。
// CC_SMOKE_RENDER=1 追加真渲染探针(打包版验收:预打 bundle + 随包浏览器全链)。
const SMOKE = process.env.CC_SMOKE === '1';
const SMOKE_RENDER = process.env.CC_SMOKE_RENDER === '1';
const SMOKE_TIMEOUT_MS = SMOKE_RENDER ? 240_000 : 90_000;

/** Main-process IPC boundary check. The renderer applies the full migration schema. */
function isProjectDocument(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  return Number.isInteger(doc.version)
    && Array.isArray(doc.assets)
    && Array.isArray(doc.mediaFolders)
    && Array.isArray(doc.timelines)
    && typeof doc.activeTimelineId === 'string';
}

function registerDesktopHandlers(secrets: CutaiSecretStore, cliAgents: CliAgentHost): void {
  ipcMain.handle('cutai:secret-set', async (_event, value: unknown, existingRef?: unknown) => {
    if (typeof value !== 'string' || value.length > 32_000) throw new Error('Invalid secret value');
    return secrets.set(value, typeof existingRef === 'string' ? existingRef : undefined);
  });
  ipcMain.handle('cutai:secret-has', async (_event, ref: unknown) => secrets.has(typeof ref === 'string' ? ref : ''));
  ipcMain.handle('cutai:secret-delete', async (_event, ref: unknown) => secrets.delete(typeof ref === 'string' ? ref : ''));
  ipcMain.handle('cutai:select-directory', async (event, requestedPath: unknown) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const requested = typeof requestedPath === 'string' && isAbsolute(requestedPath)
      ? requestedPath
      : app.getPath('videos');
    const options: OpenDialogOptions = {
      title: '选择素材保存目录',
      defaultPath: requested,
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('cutai:choose-project-save-path', async (event, requestedName: unknown) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const rawName = typeof requestedName === 'string' ? requestedName.trim() : 'Untitled';
    const safeName = rawName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 120) || 'Untitled';
    const dialogParent = parent ?? BrowserWindow.getFocusedWindow();
    const result = dialogParent
      ? await dialog.showSaveDialog(dialogParent, {
        title: '保存 CutAI 工程',
        defaultPath: join(app.getPath('documents'), `${safeName}.cutai`),
        filters: [{ name: 'CutAI 工程', extensions: ['cutai'] }],
      })
      : await dialog.showSaveDialog({ title: '保存 CutAI 工程', defaultPath: join(app.getPath('documents'), `${safeName}.cutai`) });
    if (result.canceled || !result.filePath) return null;
    return extname(result.filePath).toLowerCase() === '.cutai' ? result.filePath : `${result.filePath}.cutai`;
  });
  ipcMain.handle('cutai:choose-project-open-path', async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result = parent
      ? await dialog.showOpenDialog(parent, { title: '打开 CutAI 工程', properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ title: '打开 CutAI 工程', properties: ['openDirectory'] });
    const path = result.canceled ? null : (result.filePaths[0] ?? null);
    return path && extname(path).toLowerCase() === '.cutai' ? path : null;
  });
  ipcMain.handle('cutai:choose-workspace-path', async (event, mode: unknown) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result = parent
      ? await dialog.showOpenDialog(parent, {
        title: mode === 'open' ? '打开本地 CutAI 工程' : '选择本地工程文件夹',
        defaultPath: app.getPath('documents'),
        properties: ['openDirectory', ...(mode === 'create' ? ['createDirectory'] as const : [])],
      })
      : await dialog.showOpenDialog({
        title: mode === 'open' ? '打开本地 CutAI 工程' : '选择本地工程文件夹',
        defaultPath: app.getPath('documents'),
        properties: ['openDirectory', ...(mode === 'create' ? ['createDirectory'] as const : [])],
      });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('cutai:save-project', async (_event, requestedPath: unknown, rawDocument: unknown) => {
    if (typeof requestedPath !== 'string' || !isAbsolute(requestedPath)) throw new Error('Invalid CutAI project path');
    if (!isProjectDocument(rawDocument)) throw new Error('Project document failed validation');
    const manifest = await saveCutaiProject({
      directory: requestedPath,
      document: rawDocument,
      appVersion: app.getVersion(),
      validate: isProjectDocument,
    });
    return { path: requestedPath, projectId: manifest.projectId };
  });
  ipcMain.handle('cutai:open-project', async (_event, requestedPath: unknown) => {
    if (typeof requestedPath !== 'string' || !isAbsolute(requestedPath)) throw new Error('Invalid CutAI project path');
    const loaded = await loadCutaiProject(requestedPath, isProjectDocument);
    return { document: loaded.document, projectId: loaded.manifest.projectId, name: cutaiProjectDisplayName(requestedPath) };
  });
  ipcMain.handle('cutai:workspace-create', async (_event, requestedPath: unknown, rawDocument: unknown, requestedProjectId: unknown) => {
    if (typeof requestedPath !== 'string' || !isAbsolute(requestedPath)) throw new Error('Invalid workspace path');
    if (!isProjectDocument(rawDocument)) throw new Error('Project document failed validation');
    return createWorkspaceProject(
      requestedPath,
      rawDocument,
      app.getVersion(),
      typeof requestedProjectId === 'string' ? requestedProjectId : undefined,
    );
  });
  ipcMain.handle('cutai:workspace-open', async (_event, requestedPath: unknown) => {
    if (typeof requestedPath !== 'string' || !isAbsolute(requestedPath)) throw new Error('Invalid workspace path');
    return openWorkspaceProject(requestedPath, isProjectDocument);
  });
  ipcMain.handle('cutai:workspace-save', async (_event, requestedPath: unknown, rawDocument: unknown) => {
    if (typeof requestedPath !== 'string' || !isAbsolute(requestedPath)) throw new Error('Invalid workspace path');
    if (!isProjectDocument(rawDocument)) throw new Error('Project document failed validation');
    const manifest = await saveWorkspaceProject(requestedPath, rawDocument, app.getVersion(), isProjectDocument);
    return { rootPath: requestedPath, manifest };
  });
  ipcMain.handle('cutai:workspace-rescan', async (_event, requestedPath: unknown) => {
    if (typeof requestedPath !== 'string' || !isAbsolute(requestedPath)) throw new Error('Invalid workspace path');
    return rescanWorkspace(requestedPath);
  });
  ipcMain.handle('cutai:cli-profiles', async () => cliAgents.profiles());
  ipcMain.handle('cutai:cli-authorize', async (_event, profileId: unknown, rootPath: unknown, fingerprint: unknown) => {
    if (typeof profileId !== 'string' || typeof rootPath !== 'string' || typeof fingerprint !== 'string') {
      throw new Error('Invalid CLI authorization request');
    }
    await cliAgents.authorize(profileId, rootPath, fingerprint);
    return { authorized: true };
  });
  ipcMain.handle('cutai:cli-run', async (event, request: unknown) => {
    if (!request || typeof request !== 'object') throw new Error('Invalid CLI run request');
    const row = request as Partial<CliRunRequest>;
    if (typeof row.profileId !== 'string' || typeof row.projectId !== 'string'
      || typeof row.projectRoot !== 'string' || typeof row.prompt !== 'string') {
      throw new Error('Invalid CLI run request');
    }
    return cliAgents.run({
      ...(typeof row.runId === 'string' ? { runId: row.runId } : {}),
      profileId: row.profileId,
      projectId: row.projectId,
      projectRoot: row.projectRoot,
      prompt: row.prompt,
      ...(typeof row.sessionId === 'string' ? { sessionId: row.sessionId } : {}),
      ...(typeof row.model === 'string' ? { model: row.model } : {}),
      ...(typeof row.reasoningEffort === 'string' ? { reasoningEffort: row.reasoningEffort } : {}),
      ...(row.fileAccess === 'workspace-write' ? { fileAccess: row.fileAccess } : {}),
    }, (streamEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send('cutai:cli-event', streamEvent);
    });
  });
  ipcMain.handle('cutai:cli-cancel', async (_event, runId: unknown) => (
    typeof runId === 'string' ? cliAgents.cancel(runId) : false
  ));
}

async function smokeProbe(origin: string, win: BrowserWindow): Promise<void> {
  const res = await fetch(`${origin}/api/keys`);
  if (!res.ok) throw new Error(`/api/keys → HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body !== 'object' || body === null) throw new Error('/api/keys returned non-object');
  const mcp = await fetch(`${origin}/api/external-mcp/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'desktop-smoke', version: '1' } },
    }),
  });
  if (!mcp.ok || !(await mcp.text()).includes('"name":"openchatcut"')) {
    throw new Error(`/api/external-mcp/mcp → HTTP ${mcp.status}`);
  }
  console.log('[smoke] external MCP endpoint ok');
  const pickerType = await win.webContents.executeJavaScript(
    'typeof window.cutaiDesktop?.selectDirectory',
  ) as unknown;
  if (pickerType !== 'function') throw new Error('desktop directory picker preload is unavailable');
  console.log('[smoke] desktop directory picker preload ok');
  const secretRoundTrip = await win.webContents.executeJavaScript(`(async () => {
    const ref = await window.cutaiDesktop.setSecret('smoke-secret-value');
    const configured = await window.cutaiDesktop.hasSecret(ref);
    await window.cutaiDesktop.deleteSecret(ref);
    return configured && !(await window.cutaiDesktop.hasSecret(ref));
  })()`) as unknown;
  if (secretRoundTrip !== true) throw new Error('desktop safeStorage secret lifecycle failed');
  console.log('[smoke] safeStorage secret lifecycle ok');
  const projectPath = join(app.getPath('temp'), `cutai-smoke-${Date.now()}.cutai`);
  try {
    const projectRoundTrip = await win.webContents.executeJavaScript(`(async () => {
      const doc = { version: 3, assets: [], mediaFolders: [], timelines: [], activeTimelineId: '' };
      await window.cutaiDesktop.saveProject(${JSON.stringify(projectPath)}, doc);
      const loaded = await window.cutaiDesktop.openProject(${JSON.stringify(projectPath)});
      return loaded.document.version === 3 && Array.isArray(loaded.document.timelines);
    })()`) as unknown;
    if (projectRoundTrip !== true) throw new Error('desktop CutAI project IPC round-trip failed');
    console.log('[smoke] CutAI project IPC round-trip ok');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
  const workspacePath = join(app.getPath('temp'), `cutai-workspace-smoke-${Date.now()}-中文`);
  try {
    const workspaceRoundTrip = await win.webContents.executeJavaScript(`(async () => {
      const doc = { version: 3, assets: [], mediaFolders: [], timelines: [], activeTimelineId: '' };
      const created = await window.cutaiDesktop.createWorkspace(${JSON.stringify(workspacePath)}, doc, 'desktop-smoke-workspace');
      await window.cutaiDesktop.saveWorkspace(${JSON.stringify(workspacePath)}, doc);
      const loaded = await window.cutaiDesktop.openWorkspace(${JSON.stringify(workspacePath)});
      return created.manifest.projectId === 'desktop-smoke-workspace'
        && loaded.document.version === 3
        && Array.isArray(await window.cutaiDesktop.rescanWorkspace(${JSON.stringify(workspacePath)}));
    })()`) as unknown;
    if (workspaceRoundTrip !== true) throw new Error('desktop workspace project IPC round-trip failed');
    console.log('[smoke] workspace project IPC round-trip ok');
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
  }
  const cliProfiles = await win.webContents.executeJavaScript(
    'window.cutaiDesktop.listCliAgents()',
  ) as Array<{ kind?: unknown; executable?: unknown }>;
  if (!Array.isArray(cliProfiles)
    || !cliProfiles.some((profile) => profile.kind === 'claude')
    || !cliProfiles.some((profile) => profile.kind === 'codex')) {
    throw new Error('desktop CLI Agent registry is unavailable');
  }
  console.log('[smoke] CLI Agent registry ok');
  if (SMOKE_RENDER) {
    const state = { fps: 30, width: 640, height: 360, items: [], selectedId: null };
    const r = await fetch(`${origin}/render-still`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, frames: [0] }),
    });
    if (!r.ok) throw new Error(`/render-still → HTTP ${r.status}: ${await r.text()}`);
    const rendered = (await r.json()) as { frames?: Array<{ base64?: string }> };
    if (!rendered.frames?.[0]?.base64) throw new Error('/render-still returned no frame');
    console.log(`[smoke] render-still ok, base64 ${rendered.frames[0].base64.length}B`);
    // Remotion can emit late DevTools protocol callbacks after the response.
    // Give its browser cleanup a short drain window before Electron exits.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function boot(): Promise<void> {
  await app.whenReady();
  const userDataPath = app.getPath('userData');
  const secrets = new CutaiSecretStore(join(userDataPath, 'secrets.json'), safeStorage);
  const cliAgents = new CliAgentHost(userDataPath);
  registerDesktopHandlers(secrets, cliAgents);
  if (app.isPackaged) {
    await preparePackagedRuntime({
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
      version: app.getVersion(),
    });
  }
  const llmProxyConfig = await bootstrapLocalLlmProxy(
    join(userDataPath, 'llm-proxy.json'),
    secrets,
  );
  const { origin } = await startEmbeddedServer(DIST_DIR, llmProxyConfig);
  cliAgents.setOrigin(origin);
  console.log(`[desktop] embedded server at ${origin}`);

  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    show: !SMOKE,
    backgroundColor: '#111111',
    title: 'CutAI',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  await win.loadURL(`${origin}/`);

  if (SMOKE) {
    await smokeProbe(origin, win);
    console.log('SMOKE-OK');
    app.exit(0);
  }
  app.once('before-quit', () => cliAgents.close());
}

app.on('window-all-closed', () => app.quit());

if (SMOKE) {
  setTimeout(() => {
    console.error('smoke timed out');
    app.exit(2);
  }, SMOKE_TIMEOUT_MS).unref();
}

boot().catch((err) => {
  console.error('[desktop] boot failed:', err instanceof Error ? err.stack ?? err.message : err);
  app.exit(1);
});
