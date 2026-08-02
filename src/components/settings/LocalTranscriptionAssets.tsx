import { useState } from 'react';
import {
  LOCAL_TRANSCRIPTION_RUNTIME,
  LOCAL_TRANSCRIPTION_EXECUTION_BACKENDS,
  isLocalTranscriptionModel,
} from '../../../shared/local-transcription-assets';
import {
  DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
  normalizeLocalTranscriptionDevice,
  type LocalTranscriptionModel,
} from '../../../shared/transcription-providers';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import {
  deleteLocalModelCache,
  deleteAllLocalModelCaches,
  downloadLocalModel,
  inspectAllLocalModelCaches,
  inspectLocalModelCache,
  type LocalModelCacheEntry,
  type LocalModelCacheStatus,
} from '../../transcript/local-model-cache';
import {
  installLocalTranscriptionRuntime,
  inspectLocalTranscriptionRuntime,
  unloadLocalTranscriptionRuntime,
  type LocalTranscriptionRuntimeState,
} from '../../transcript/local-whisper';
import type { FieldCtx } from './settingsVendorPane';
import type { SettingsField } from './settingsSchema';

interface ManifestResponse {
  ok: boolean;
  expectedBytes?: number;
  files?: Array<{ path: string; bytes: number }>;
  message?: string;
}

interface CheckedModel {
  model: LocalTranscriptionModel;
  cache: LocalModelCacheStatus;
  expectedBytes: number | null;
  error: string | null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** index);
  return `${value >= 100 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function selectedModel(ctx: FieldCtx): LocalTranscriptionModel {
  const value = ctx.values.TRANSCRIPTION_LOCAL_MODEL
    ?? ctx.status?.models.TRANSCRIPTION_LOCAL_MODEL
    ?? DEFAULT_LOCAL_TRANSCRIPTION_MODEL;
  return isLocalTranscriptionModel(value) ? value : DEFAULT_LOCAL_TRANSCRIPTION_MODEL;
}

export function LocalTranscriptionAssets({ ctx }: { ctx: FieldCtx }) {
  const t = useT();
  const configuredModel = ctx.values.TRANSCRIPTION_LOCAL_MODEL
    ?? ctx.status?.models.TRANSCRIPTION_LOCAL_MODEL
    ?? '';
  const model = selectedModel(ctx);
  const configuredDevice = ctx.values.TRANSCRIPTION_LOCAL_DEVICE
    ?? ctx.status?.models.TRANSCRIPTION_LOCAL_DEVICE
    ?? '';
  const device = normalizeLocalTranscriptionDevice(configuredDevice);
  const effectiveDevice = device === 'auto'
    ? (typeof navigator !== 'undefined' && 'gpu' in navigator ? 'webgpu' : 'wasm')
    : device;
  const backend = LOCAL_TRANSCRIPTION_EXECUTION_BACKENDS.find((entry) => entry.id === effectiveDevice)
    ?? LOCAL_TRANSCRIPTION_EXECUTION_BACKENDS[0];
  const route = ctx.values.PREFERRED_TRANSCRIPTION_VENDOR
    ?? ctx.status?.models.PREFERRED_TRANSCRIPTION_VENDOR
    ?? '';
  const localActive = route === 'local';
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  const [runtimeState, setRuntimeState] = useState<LocalTranscriptionRuntimeState>(() => inspectLocalTranscriptionRuntime());
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [deleteAllBusy, setDeleteAllBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [checked, setChecked] = useState<CheckedModel | null>(null);
  const [allCaches, setAllCaches] = useState<LocalModelCacheEntry[]>([]);
  const shown = checked?.model === model ? checked : null;

  const checkModel = async (): Promise<void> => {
    setModelBusy(true);
    try {
      const cache = await inspectLocalModelCache(model);
      const caches = await inspectAllLocalModelCaches();
      setAllCaches(caches);
      let expectedBytes: number | null = null;
      let error: string | null = null;
      try {
        const response = await fetch(`/api/local-model-assets?model=${encodeURIComponent(model)}`, {
          cache: 'no-store',
        });
        const body = await response.json() as ManifestResponse;
        if (!response.ok || !body.ok || typeof body.expectedBytes !== 'number') {
          throw new Error(body.message || `HTTP ${response.status}`);
        }
        expectedBytes = body.expectedBytes;
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason);
      }
      setChecked({ model, cache, expectedBytes, error });
    } finally {
      setModelBusy(false);
    }
  };

  const removeModel = async (): Promise<void> => {
    if (!window.confirm(t('确定删除所选模型 {model} 的本机缓存吗？下次使用会重新下载。', { model }))) return;
    setDeleteBusy(true);
    try {
      await deleteLocalModelCache(model);
      await checkModel();
    } finally {
      setDeleteBusy(false);
    }
  };

  const downloadModel = async (): Promise<void> => {
    setDownloadBusy(true);
    setDownloadProgress(0);
    setActionError(null);
    try {
      const response = await fetch(`/api/local-model-assets?model=${encodeURIComponent(model)}`, { cache: 'no-store' });
      const body = await response.json() as ManifestResponse;
      if (!response.ok || !body.ok || !body.files?.length) throw new Error(body.message || `HTTP ${response.status}`);
      await downloadLocalModel(model, body.files, (downloaded, total) => {
        setDownloadProgress(total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : 0);
      });
      await checkModel();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
      await checkModel();
    } finally {
      setDownloadBusy(false);
      setDownloadProgress(null);
    }
  };

  const removeAllModels = async (): Promise<void> => {
    const cached = allCaches.filter((entry) => entry.cache.cachedFiles > 0);
    if (!cached.length) return;
    if (!window.confirm(t('确定删除全部本地转写模型缓存吗？下次使用时会重新下载。'))) return;
    setDeleteAllBusy(true);
    try {
      await deleteAllLocalModelCaches();
      await checkModel();
    } finally {
      setDeleteAllBusy(false);
    }
  };

  const replaceRuntime = async (): Promise<void> => {
    const next = effectiveDevice === 'webgpu' ? 'wasm' : 'webgpu';
    const field: SettingsField = {
      name: 'TRANSCRIPTION_LOCAL_DEVICE', label: '推理设备', kind: 'select',
    };
    setRuntimeBusy(true);
    try {
      if (next === 'webgpu') {
        const gpu = typeof navigator !== 'undefined'
          ? (navigator as Navigator & { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu
          : undefined;
        let available = Boolean(gpu);
        if (available && gpu?.requestAdapter) {
          try {
            available = Boolean(await gpu.requestAdapter());
          } catch {
            available = false;
          }
        }
        if (!available) {
          setActionError(t('当前环境没有 WebGPU，无法切换；请保留 WASM（CPU）后端。'));
          return;
        }
      }
      unloadLocalTranscriptionRuntime();
      installLocalTranscriptionRuntime();
      ctx.onStage(field, next);
      setRuntimeState(inspectLocalTranscriptionRuntime());
      setRuntimeChecked(true);
      setActionError(null);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRuntimeBusy(false);
    }
  };

  const toggleRuntime = (): void => {
    if (runtimeState === 'uninstalled') {
      installLocalTranscriptionRuntime();
      setRuntimeState(inspectLocalTranscriptionRuntime());
      setRuntimeChecked(true);
      setActionError(null);
      return;
    }
    if (!window.confirm(t('卸载本地转写运行框架实例吗？这会终止正在进行的本地转写并释放模型内存；应用代码包不会删除。'))) return;
    setRuntimeBusy(true);
    try {
      unloadLocalTranscriptionRuntime();
      setRuntimeState(inspectLocalTranscriptionRuntime());
      setRuntimeChecked(true);
    } finally {
      setRuntimeBusy(false);
    }
  };

  const modelMessage = (() => {
    if (!shown) return t('点击检查所选模型是否已下载，并读取预计下载大小。');
    const expected = shown.expectedBytes == null ? t('大小暂时无法读取') : t('预计 {size}', {
      size: formatBytes(shown.expectedBytes),
    });
    if (shown.cache.state === 'downloaded') {
      return t('已下载 · 本机缓存 {cached} · {expected}', {
        cached: formatBytes(shown.cache.cachedBytes),
        expected,
      });
    }
    if (shown.cache.state === 'partial') {
      return t('部分下载 · 本机缓存 {cached} · {expected}', {
        cached: formatBytes(shown.cache.cachedBytes),
        expected,
      });
    }
    if (shown.cache.state === 'unavailable') {
      return t('当前环境不支持浏览器模型缓存 · {expected}', { expected });
    }
    return t('未下载 · {expected}', { expected });
  })();

  return (
    <section style={assetBox}>
      {!localActive && (
        <div style={routeWarning}>
          <span>{t('当前实际转写后端不是本地 Whisper，点击下方按钮启用；保存后才会生效。')}</span>
          <button type="button" style={actionButton} onClick={() => {
            const routeField: SettingsField = {
              name: 'PREFERRED_TRANSCRIPTION_VENDOR', label: '转写后端', kind: 'select',
            };
            ctx.onStage(routeField, 'local');
          }}>{t('启用本地 Whisper')}</button>
        </div>
      )}
      {configuredModel && !isLocalTranscriptionModel(configuredModel) && (
        <div style={routeWarning}>
          <span>{t('检测到旧版本地模型 {model}，它与当前运行框架不兼容；转写会改用 {fallback}。', {
            model: configuredModel,
            fallback: DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
          })}</span>
          <button type="button" style={actionButton} onClick={() => {
            const modelField: SettingsField = {
              name: 'TRANSCRIPTION_LOCAL_MODEL', label: '本地模型', kind: 'select',
            };
            ctx.onStage(modelField, DEFAULT_LOCAL_TRANSCRIPTION_MODEL);
          }}>{t('切换到兼容模型')}</button>
        </div>
      )}
      <div style={assetRow}>
        <div style={assetText}>
          <b style={assetTitle}>{t('本地运行框架')}</b>
          <span style={assetHint}>
            {runtimeChecked
              ? t('{state} · {name} {version} · {size} · 当前后端：{backend}', {
                  state: runtimeState === 'installed' ? t('运行实例已启用') : t('运行实例已卸载'),
                  name: LOCAL_TRANSCRIPTION_RUNTIME.label,
                  version: LOCAL_TRANSCRIPTION_RUNTIME.version,
                  size: formatBytes(LOCAL_TRANSCRIPTION_RUNTIME.bytes),
                  backend: t(backend.label),
                })
              : t('点击检查运行框架状态；可切换 WASM/WebGPU，或卸载当前运行实例。')}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 7, flex: '0 0 auto' }}>
          <button type="button" style={actionButton} disabled={runtimeBusy}
            onClick={() => { setRuntimeState(inspectLocalTranscriptionRuntime()); setRuntimeChecked(true); }}>
            {t('检查运行框架')}
          </button>
          <button type="button" style={actionButton} disabled={runtimeBusy}
            onClick={() => { void replaceRuntime(); }}>
            {runtimeBusy ? t('处理中…') : t('替换执行后端')}
          </button>
          <button type="button" style={{ ...actionButton, color: runtimeState === 'installed' ? '#f77' : theme.success }}
            disabled={runtimeBusy}
            onClick={toggleRuntime}>
            {runtimeState === 'installed' ? t('卸载运行实例') : t('恢复运行框架')}
          </button>
        </div>
      </div>
      <div style={{ ...assetRow, borderTop: `0.5px solid ${theme.border}`, paddingTop: 9 }}>
        <div style={assetText}>
          <b style={assetTitle}>{t('所选模型缓存')}</b>
          <span style={{ ...assetHint, color: shown?.cache.state === 'downloaded' ? theme.success : theme.textDim }}>
            {modelMessage}
          </span>
          {(shown?.error || actionError) && <span style={{ ...assetHint, color: '#f77' }}>{t('大小查询失败：{message}', { message: shown?.error || actionError || '' })}</span>}
        </div>
        <div style={{ display: 'flex', gap: 7, flex: '0 0 auto' }}>
          <button type="button" style={actionButton} disabled={downloadBusy || modelBusy || deleteBusy || shown?.cache.state === 'downloaded'}
            onClick={() => { void downloadModel(); }}>
            {downloadBusy ? t('下载中 {progress}%', { progress: downloadProgress ?? 0 }) : t('下载模型')}
          </button>
          <button type="button" style={actionButton} disabled={modelBusy || deleteBusy}
            onClick={() => { void checkModel(); }}>
            {modelBusy ? t('检查中…') : t('检查所选模型')}
          </button>
          <button type="button" style={{ ...actionButton, color: '#f77' }}
            disabled={!shown?.cache.cachedFiles || modelBusy || deleteBusy || downloadBusy}
            onClick={() => { void removeModel(); }}>
            {deleteBusy ? t('删除中…') : t('删除本地模型')}
          </button>
        </div>
      </div>
      {allCaches.some((entry) => entry.cache.cachedFiles > 0) && (
        <div style={{ ...assetRow, borderTop: `0.5px solid ${theme.border}`, paddingTop: 8 }}>
          <div style={assetText}>
            <b style={assetTitle}>{t('已缓存的本地模型')}</b>
            <span style={assetHint}>
              {allCaches.filter((entry) => entry.cache.cachedFiles > 0)
                .map((entry) => `${entry.model}（${formatBytes(entry.cache.cachedBytes)}）`)
                .join('、')}
            </span>
          </div>
          <button type="button" style={{ ...actionButton, color: '#f77' }}
            disabled={deleteAllBusy || modelBusy || deleteBusy || downloadBusy}
            onClick={() => { void removeAllModels(); }}>
            {deleteAllBusy ? t('删除中…') : t('删除全部本地模型')}
          </button>
        </div>
      )}
      <span style={footnote}>{t('模型缓存可逐个或全部删除；卸载运行实例会释放 Worker 与模型内存，应用包中的运行框架代码保留，恢复后按需重新加载。')}</span>
    </section>
  );
}

const assetBox: React.CSSProperties = {
  background: theme.bg,
  border: `0.5px solid ${theme.border}`,
  borderRadius: 4,
  padding: '10px 13px',
  display: 'flex',
  flexDirection: 'column',
  gap: 9,
};
const routeWarning: React.CSSProperties = {
  color: '#d66b35',
  background: 'color-mix(in srgb, #d66b35 10%, transparent)',
  border: '0.5px solid #d66b35',
  borderRadius: 5,
  padding: '7px 9px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  fontSize: 10.5,
  lineHeight: 1.4,
};
const assetRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
};
const assetText: React.CSSProperties = {
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
};
const assetTitle: React.CSSProperties = { color: theme.text, fontSize: 11.5 };
const assetHint: React.CSSProperties = { color: theme.textDim, fontSize: 10.5, lineHeight: 1.4 };
const footnote: React.CSSProperties = { color: theme.textDim, fontSize: 10, lineHeight: 1.4 };
const actionButton: React.CSSProperties = {
  font: 'inherit',
  fontSize: 11,
  color: theme.text,
  background: theme.panelAlt,
  border: `0.5px solid ${theme.border}`,
  borderRadius: 5,
  padding: '5px 9px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
