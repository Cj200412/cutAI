import { useState } from 'react';
import {
  LOCAL_TRANSCRIPTION_RUNTIME,
  isLocalTranscriptionModel,
} from '../../../shared/local-transcription-assets';
import {
  DEFAULT_LOCAL_TRANSCRIPTION_MODEL,
  type LocalTranscriptionModel,
} from '../../../shared/transcription-providers';
import { useT } from '../../i18n/locale';
import { theme } from '../../theme';
import {
  deleteLocalModelCache,
  downloadLocalModel,
  inspectLocalModelCache,
  type LocalModelCacheStatus,
} from '../../transcript/local-model-cache';
import type { FieldCtx } from './settingsVendorPane';

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
  const model = selectedModel(ctx);
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [checked, setChecked] = useState<CheckedModel | null>(null);
  const shown = checked?.model === model ? checked : null;

  const checkModel = async (): Promise<void> => {
    setModelBusy(true);
    try {
      const cache = await inspectLocalModelCache(model);
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
      <div style={assetRow}>
        <div style={assetText}>
          <b style={assetTitle}>{t('本地运行框架')}</b>
          <span style={assetHint}>
            {runtimeChecked
              ? t('已随应用安装 · {name} {version} · {size}', {
                  name: LOCAL_TRANSCRIPTION_RUNTIME.label,
                  version: LOCAL_TRANSCRIPTION_RUNTIME.version,
                  size: formatBytes(LOCAL_TRANSCRIPTION_RUNTIME.bytes),
                })
              : t('点击确认运行框架是否随应用安装，并查看体积。')}
          </span>
        </div>
        <button type="button" style={actionButton} onClick={() => setRuntimeChecked(true)}>
          {t('检查运行框架')}
        </button>
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
      <span style={footnote}>{t('仅删除所选模型的 Transformers.js 缓存；运行框架随应用保留。')}</span>
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
const assetRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
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
