import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { theme } from './theme';
import { Dashboard } from './components/Dashboard';
import {
  listProjects, loadProject, createProject, renameProject, duplicateProject,
  randomProjectName, docFromTimeline, hasProjectHistory, migrateProjectDoc, updateProjectMeta, saveProject, type ProjectMeta,
} from './persist/projectStore';
import type { ProjectDoc, TimelineState } from './editor/types';
import { applyProjectImport, buildProjectExport, parseProjectEnvelope } from './persist/projectTransfer';
import { purgeProjectCascade } from './persist/mediaCleanup';
import { applyLiveCaps, applyLiveKeyStatus, applyLiveModels } from './agent/capabilities';
import { applyAgentModelCatalogs, applyAgentModelStatus } from './agent/model-selection';
import { LLM_PROVIDER_PRESETS, llmProviderConfigNames } from '../shared/llm-providers';
import { useT } from './i18n/locale';

const Editor = lazy(() => import('./Editor'));

// A brand-new project starts empty; the first-run "示例工程" gets the seed clips.
const emptyState = (): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  items: [],
  selectedId: null,
  trackOrder: ['track_v1'],
  tracks: { track_v1: { kind: 'video' } },
});
const emptyDoc = (): ProjectDoc => docFromTimeline(emptyState());
const seedDoc = async (): Promise<ProjectDoc> => docFromTimeline((await import('./editor/initial')).INITIAL);

function withWorkspaceMedia(doc: ProjectDoc, media: WorkspaceMediaResult[]): ProjectDoc {
  const supported = media.filter(
    (
      item,
    ): item is WorkspaceMediaResult & {
      kind: Exclude<WorkspaceMediaResult['kind'], 'subtitle'>;
    } => item.kind !== 'subtitle',
  );
  const existing = new Set(doc.assets.map((asset) => asset.src));
  return {
    ...doc,
    assets: [
      ...doc.assets,
      ...supported.filter((item) => !existing.has(item.url)).map((item) => ({
        id: item.id,
        name: item.name,
        kind: item.kind,
        src: item.url,
        durationInFrames: item.kind === 'image' || item.kind === 'gif' || item.kind === 'svg' ? 150 : 30,
      })),
    ],
  };
}

type Route = { name: 'dashboard' } | { name: 'editor'; id: string };
function parseHash(): Route {
  const m = window.location.hash.match(/^#\/editor\/(.+)$/);
  return m ? { name: 'editor', id: m[1] } : { name: 'dashboard' };
}
const go = (hash: string) => { window.location.hash = hash; };

function Splash({ text }: { text: string }) {
  return (
    <div style={{ height: '100vh', display: 'grid', placeItems: 'center', background: theme.bg, color: theme.textDim, fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>
      {text}
    </div>
  );
}

// Load one project's timeline, then mount the editor for it.
function EditorLoader({ meta, onHome, onRename }: { meta: ProjectMeta; onHome: () => void; onRename: (name: string) => void }) {
  const t = useT();
  const [initial, setInitial] = useState<ProjectDoc | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      let document = await loadProject(meta.id);
      if (meta.storageMode === 'workspace' && meta.rootPath && window.cutaiDesktop) {
        try {
          const loaded = await window.cutaiDesktop.openWorkspace(meta.rootPath);
          const migrated = migrateProjectDoc(loaded.document);
          if (migrated) {
            document = withWorkspaceMedia(migrated, loaded.media);
            await saveProject(meta.id, document);
          }
        } catch {
          // Keep the local cache available when a workspace is temporarily offline.
        }
      }
      if (alive) setInitial(document ?? emptyDoc());
    })();
    return () => { alive = false; };
  }, [meta.id, meta.rootPath, meta.storageMode]);
  if (!initial) return <Splash text={t('加载工程…')} />;
  return <Suspense fallback={<Splash text={t('加载编辑器…')} />}><Editor initial={initial} project={meta} onHome={onHome} onRename={onRename} /></Suspense>;
}

export default function App() {
  const t = useT();
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [route, setRoute] = useState<Route>(parseHash());

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Sync the agent's capability manifest with the server's live key state (corrects the
  // build-time __CONFIGURED_CAPS__ snapshot after any key edited in a prior session).
  // keys (booleans only) refine the manifest to vendor granularity.
  useEffect(() => {
    fetch('/api/keys')
      .then((r) => r.json() as Promise<{ caps?: Record<string, boolean>; keys?: Record<string, { configured: boolean }>; models?: Record<string, string> }>)
      .then((d) => {
        if (d?.caps) applyLiveCaps(d.caps);
        if (d?.keys) applyLiveKeyStatus(d.keys);
        if (d?.models) {
          applyLiveModels(d.models);              // per-vendor models + PREFERRED_* routing
          applyAgentModelStatus(d.keys ?? {}, d.models);
          const configured = LLM_PROVIDER_PRESETS.filter(
            (preset) => d.keys?.[llmProviderConfigNames(preset.id).apiKey]?.configured,
          );
          void Promise.all(configured.map(async (preset) => {
            const response = await fetch('/api/keys/test', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ page: `llm/${preset.id}`, overrides: {} }),
            });
            const result = await response.json() as { ok?: boolean; models?: unknown };
            return [
              preset.id,
              result.ok && Array.isArray(result.models)
                ? result.models.filter((model): model is string => typeof model === 'string')
                : [],
            ] as const;
          })).then((entries) => {
            applyAgentModelCatalogs(Object.fromEntries(entries), d.keys ?? {}, d.models ?? {});
          }).catch(() => { /* keep configured defaults when discovery is unavailable */ });
        }
      })
      .catch(() => { /* dev endpoint absent (e.g. preview build) — keep the define snapshot */ });
  }, []);

  const refresh = useCallback(async () => { setProjects(await listProjects()); }, []);

  useEffect(() => {
    (async () => {
      let list = await listProjects();
      if (list.length === 0 && !(await hasProjectHistory())) {
        list = [await createProject('示例工程', await seedDoc(), { storageMode: 'internal' })];
      }
      setProjects(list);
    })();
  }, []);

  if (!projects) return <Splash text={t('加载中…')} />;

  if (route.name === 'editor') {
    const meta = projects.find((p) => p.id === route.id);
    if (!meta) { go('#/'); return <Splash text={t('工程不存在，返回…')} />; }
    return (
      <EditorLoader
        key={meta.id}
        meta={meta}
        onHome={() => go('#/')}
        onRename={async (name) => { await renameProject(meta.id, name); refresh(); }}
      />
    );
  }

  return (
    <Dashboard
      projects={projects}
      onOpen={(id) => go(`#/editor/${id}`)}
      onNew={async () => {
        const desktop = window.cutaiDesktop;
        if (!desktop) {
          const m = await createProject(randomProjectName(), emptyDoc(), { storageMode: 'internal' });
          await refresh(); go(`#/editor/${m.id}`); return;
        }
        const rootPath = await desktop.chooseWorkspacePath('create');
        if (!rootPath) return;
        const created = await desktop.createWorkspace(rootPath, emptyDoc());
        const document = withWorkspaceMedia(migrateProjectDoc(created.document) ?? emptyDoc(), created.media);
        await desktop.saveWorkspace(rootPath, document);
        const meta = await createProject(created.manifest.name, document, {
          id: created.manifest.projectId,
          storageMode: 'workspace',
          rootPath,
          projectFileVersion: created.manifest.schemaVersion,
        });
        await refresh();
        go(`#/editor/${meta.id}`);
      }}
      onNewTemporary={async () => {
        const m = await createProject(randomProjectName(), emptyDoc(), { storageMode: 'internal' });
        await refresh();
        go(`#/editor/${m.id}`);
      }}
      onOpenWorkspace={async () => {
        const desktop = window.cutaiDesktop;
        if (!desktop) return t('仅桌面版支持本地文件夹工程');
        const rootPath = await desktop.chooseWorkspacePath('open');
        if (!rootPath) return t('已取消打开');
        const loaded = await desktop.openWorkspace(rootPath);
        const migrated = migrateProjectDoc(loaded.document);
        if (!migrated) return t('打开失败:工程数据校验不通过');
        const document = withWorkspaceMedia(migrated, loaded.media);
        await desktop.saveWorkspace(rootPath, document);
        const existing = projects.find((project) => project.id === loaded.manifest.projectId);
        if (existing) {
          await saveProject(existing.id, document);
          await updateProjectMeta(existing.id, {
            name: loaded.manifest.name,
            storageMode: 'workspace',
            rootPath,
            projectFileVersion: loaded.manifest.schemaVersion,
          });
          await refresh();
          go(`#/editor/${existing.id}`);
          return t('已打开本地工程「{name}」', { name: loaded.manifest.name });
        }
        const meta = await createProject(loaded.manifest.name, document, {
          id: loaded.manifest.projectId,
          storageMode: 'workspace',
          rootPath,
          projectFileVersion: loaded.manifest.schemaVersion,
        });
        await refresh();
        go(`#/editor/${meta.id}`);
        return t('已打开本地工程「{name}」', { name: loaded.manifest.name });
      }}
      onMigrateWorkspace={async (id) => {
        const desktop = window.cutaiDesktop;
        if (!desktop) return t('仅桌面版支持迁移到本地文件夹');
        const rootPath = await desktop.chooseWorkspacePath('create');
        if (!rootPath) return t('已取消迁移');
        const document = await loadProject(id);
        if (!document) return t('迁移失败:工程不存在或已损坏');
        const created = await desktop.createWorkspace(rootPath, document, id);
        const merged = withWorkspaceMedia(document, created.media);
        await desktop.saveWorkspace(rootPath, merged);
        await updateProjectMeta(id, {
          name: created.manifest.name,
          storageMode: 'workspace',
          rootPath,
          projectFileVersion: created.manifest.schemaVersion,
        });
        await refresh();
        return t('已迁移到本地工程「{name}」', { name: created.manifest.name });
      }}
      onRename={async (id, name) => { await renameProject(id, name); refresh(); }}
      onDuplicate={async (id) => { await duplicateProject(id); refresh(); }}
      onDelete={async (id) => { await purgeProjectCascade(id); refresh(); }}  // 级联:删工程 + 清其独占素材
      onExport={async (id, name) => {
        const r = await buildProjectExport(id, name);
        downloadBlob(r.blob, r.filename);
        return r.mediaMissing.length
          ? t('已导出「{name}」;{n} 个素材两端都取不到,未随包', { name, n: r.mediaMissing.length })
          : t('已导出「{name}」(含 {n} 个素材)', { name, n: r.mediaTotal });
      }}
      onSaveCutaiProject={async (id, name) => {
        const desktop = window.cutaiDesktop;
        if (!desktop) return t('仅桌面版支持保存 .cutai 工程');
        const path = await desktop.chooseProjectSavePath(name);
        if (!path) return t('已取消保存');
        const document = await loadProject(id);
        if (!document) return t('保存失败:工程不存在或已损坏');
        await desktop.saveProject(path, document);
        return t('已保存 CutAI 工程「{name}」', { name });
      }}
      onOpenCutaiProject={async () => {
        const desktop = window.cutaiDesktop;
        if (!desktop) return t('仅桌面版支持打开 .cutai 工程');
        const path = await desktop.chooseProjectOpenPath();
        if (!path) return t('已取消打开');
        const loaded = await desktop.openProject(path);
        const document = migrateProjectDoc(loaded.document);
        if (!document) return t('打开失败:工程数据校验不通过');
        const meta = await createProject(loaded.name, document, { storageMode: 'legacy-package' });
        await refresh();
        go(`#/editor/${meta.id}`);
        return t('已打开 CutAI 工程「{name}」', { name: loaded.name });
      }}
      onImport={async (file) => {
        const parsed = parseProjectEnvelope(await file.text());
        if ('error' in parsed) return t('导入失败:{error}', { error: parsed.error });
        const r = await applyProjectImport(parsed.envelope);
        await refresh();
        return r.mediaMissing.length
          ? t('已导入「{name}」;缺 {n} 个素材({list})', { name: r.meta.name, n: r.mediaMissing.length, list: r.mediaMissing.map((s: string) => s.split('/').pop()).join('、') })
          : t('已导入「{name}」(素材 {a}/{b})', { name: r.meta.name, a: r.mediaRestored, b: r.mediaTotal });
      }}
    />
  );
}

// Blob 下载:同步 revoke 会掐掉 Chrome 的下载(插件导出踩过),必须挂 DOM + 延时回收。
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
