import { useEffect, useState } from 'react';
import { theme } from '../../theme';
import { Icon } from '../icons';
import { useT } from '../../i18n/locale';
import type { DisplayMessage } from '../../agent/useAgent';
import { parseWidgets } from './widget-parse';
import { WidgetCard } from './WidgetCard';
import { Markdown } from './Markdown';
import { hasToolResultError } from './tool-result';

const GREEN = theme.success;

function ThinkingElapsed({ active, elapsedMs = 0, startedAt }: { active: boolean; elapsedMs?: number; startedAt?: number }) {
  const [fallbackStartedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [active]);
  const liveMs = active ? Math.max(0, now - (startedAt ?? fallbackStartedAt)) : 0;
  return <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', opacity: 0.65 }}>{((elapsedMs + liveMs) / 1000).toFixed(1)}s</span>;
}

// 从工具参数里取「最有区分度」的那一个做行内摘要——按识别性排序:先具体标识
// (query/itemId/名字…)，再泛化(action/target…)。让同名多次调用一眼可辨，不再像重复。
const SUMMARY_KEYS = ['query', 'itemId', 'templateName', 'audioName', 'name', 'from', 'to', 'templateId', 'category', 'ratio', 'action', 'format', 'target', 'track', 'renderId'];
function toolArgSummary(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  for (const k of SUMMARY_KEYS) {
    const v = a[k];
    if (v === undefined || v === null || v === '') continue;
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (k === 'itemId' || k === 'templateId' || k === 'renderId') s = s.slice(0, 8); // uuid 只取前 8
    if (s.length > 26) s = s.slice(0, 24) + '…';
    return s;
  }
  return '';
}

function toolPreview(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); }
}

// 折叠的「思考过程」块 — 原生 thinking 流与内联 <thinking> 抽取都归到这里
// (两者统一折成 thinking 块,默认折叠)。
function ThinkingBlock({ text, active, elapsedMs, startedAt }: { text: string; active: boolean; elapsedMs?: number; startedAt?: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 6 }}>
      <button onClick={() => setOpen((v) => !v)} title={open ? t('收起思考过程') : t('展开思考过程')}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.textDim, fontSize: 11.5, padding: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ display: 'inline-flex', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▸</span>
        {t('思考过程')}<ThinkingElapsed active={active} elapsedMs={elapsedMs} startedAt={startedAt} />
      </button>
      {open && (
        <Markdown text={text} style={{ marginTop: 4, maxHeight: 180, overflowY: 'auto', padding: '6px 8px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontStyle: 'italic', fontSize: 11.5, lineHeight: 1.55, color: theme.textDim, whiteSpace: 'pre-wrap', background: theme.panelAlt, border: `0.5px solid ${theme.border}`, borderRadius: 4 }} />
      )}
    </div>
  );
}

interface ChatMessageProps {
  msg: DisplayMessage;
  /** the actively-streaming assistant turn hides the copy button until done */
  streaming?: boolean;
  /** 用户填完 <widget> 表单卡并提交后，回传拼好的答案文本。 */
  onWidgetSubmit?: (answer: string) => void;
  /** maxTurns 暂停卡「继续」;仅最后一条 continue 卡可点(旧卡只读) */
  onContinue?: (() => void) | null;
}

export function ChatMessage({ msg, streaming, onWidgetSubmit, onContinue }: ChatMessageProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [toolOpen, setToolOpen] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(msg.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {});
  };

  if (msg.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '16px 0' }}>
      <div style={{ maxWidth: '86%', background: theme.hover, color: theme.text, borderRadius: 6, padding: '9px 14px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.5 }}>{msg.text}</div>
      </div>
    );
  }

  if (msg.role === 'tool') {
    const tool = msg.tool!;
    const r = tool.result;
    const hasError = hasToolResultError(r);
    const error = hasError
      ? r.error
      : undefined;
    const ok = !hasError;
    // 关键参数摘要:同名工具的多次调用(search_templates×7、normalize_loudness×8…)
    // 之前只印工具名，看着像重复；补上区分性参数(query/itemId/category…)一眼可辨。
    const summary = toolArgSummary(tool.args);
    const argsText = toolPreview(tool.args);
    const resultText = toolPreview(r);
    const previewText = `参数\n${argsText}\n\n结果\n${resultText}`;
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, margin: '9px 0', color: theme.textDim, fontSize: 12.5 }}
        title={typeof tool.args === 'object' ? JSON.stringify(tool.args) : String(tool.args)}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: ok ? GREEN : theme.danger, flexShrink: 0, marginTop: 5 }} />
        {/* 工具名 + 摘要 + 错误同处一个可换行块:minWidth:0 让它能在 flex 父内收缩，
            overflowWrap:anywhere 断长 token —— 长错误/摘要在面板内 wrap，不再单行溢出被裁。 */}
        <span style={{ minWidth: 0, overflowWrap: 'anywhere', lineHeight: 1.45 }}>
          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: 0.2 }}>{tool.name}</span>
          {summary && <span style={{ opacity: 0.8 }}> · {summary}</span>}
          {!ok && <span style={{ color: theme.danger }}>：{String(error)}</span>}
          <button type="button" onClick={() => setToolOpen((value) => !value)}
            style={{ display: 'block', marginTop: 3, padding: 0, border: 0, background: 'none', color: theme.accent, cursor: 'pointer', fontSize: 11 }}>
            {toolOpen ? t('收起工具详情') : t('预览工具详情')}
          </button>
          {toolOpen && <pre style={{ margin: '5px 0 0', maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '6px 8px', borderRadius: 4, background: theme.panelAlt, color: theme.textDim, fontSize: 10.5, lineHeight: 1.45 }}>{previewText.slice(0, 12000)}{previewText.length > 12000 ? '\n…' : ''}</pre>}
        </span>
      </div>
    );
  }

  if (msg.role === 'error') {
    return <div style={{ color: theme.danger, fontSize: 12.5, margin: '8px 0' }}>⚠ {msg.text}</div>;
  }

  // maxTurns 暂停卡(「继续?」):text = 已执行轮数
  if (msg.role === 'continue') {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0', padding: '9px 12px',
        border: `0.5px solid ${theme.border}`, borderRadius: 4, background: theme.panelAlt, fontSize: 12.5, color: theme.textDim,
      }}>
        <span style={{ flex: 1 }}>{t('已连续执行 {n} 轮工具，先停一下确认方向。', { n: msg.text })}</span>
        {onContinue && (
          <button type="button" onClick={onContinue}
            style={{ border: `0.5px solid ${theme.accent}`, background: 'transparent', color: theme.accent, borderRadius: 6, padding: '4px 14px', fontSize: 12.5, cursor: 'pointer', flexShrink: 0 }}>
            {t('继续')}
          </button>
        )}
      </div>
    );
  }

  // assistant 文本里可能嵌入 <widget> 表单块，需拆段落分别渲染。
  // 纯文本段走轻量 Markdown（**粗体** / `code` / 列表 / 代码块），不再把 ** 原样吐给用户
  const segments = parseWidgets(msg.text);
  return (
    <div style={{ margin: '16px 0' }}>
      {!!msg.thinking?.trim() && <ThinkingBlock
        text={msg.thinking}
        active={msg.thinkingActive ?? (!!streaming && !!msg.thinking && !msg.text)}
        elapsedMs={msg.thinkingElapsedMs}
        startedAt={msg.thinkingStartedAt}
      />}
      {msg.actualModel && (
        <div style={{ marginBottom: 6, color: theme.textDim, fontSize: 10.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
          实际模型：{msg.actualModel}{msg.requestedModel ? ` · 选择：${msg.requestedModel}` : ''}
        </div>
      )}
      {segments.map((seg, i) =>
        seg.type === 'widget' ? (
          <WidgetCard
            key={i}
            fields={seg.fields}
            title={seg.title}
            submitLabel={seg.submitLabel}
            messagePrefix={seg.messagePrefix}
            onSubmit={(answer) => onWidgetSubmit?.(answer)}
          />
        ) : (
          seg.text ? <Markdown key={i} text={seg.text} /> : null
        ),
      )}
      {!streaming && msg.text.trim() && (
        <div style={{ marginTop: 6, marginLeft: -5 }}>
          <button title={copied ? t('已复制') : t('复制文本')} onClick={copy}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 5, borderRadius: 6, lineHeight: 0, color: copied ? theme.text : theme.textDim, display: 'grid', placeItems: 'center' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = theme.panelAlt; e.currentTarget.style.color = theme.text; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = copied ? theme.text : theme.textDim; }}>
            <Icon name="copy" size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
