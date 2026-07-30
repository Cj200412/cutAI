import { useEffect, useRef, useState } from 'react';
import { theme } from '../../theme';
import { useT } from '../../i18n/locale';
import { resolveAgentReferences, type AgentContext, type AgentReference } from '../../agent/context';
import type { MediaAsset, TimelineState } from '../../editor/types';
import { kindOf } from '../../media/upload';
import { useAgent } from '../../agent/useAgent';
import type { DisplayMessage } from '../../agent/useAgent';
import { useExternalAgentBridge } from '../../agent/useExternalAgentBridge';
import { ExternalProposalCard } from './ExternalProposalCard';
import { thinkingPhrase } from './thinkingPhrases';
import { onSelectionRef, refPromptToken, setSelectionRefMode } from '../../agent/selection-refs';
import { shouldBlockAutoApply } from '../../agent/skills/skillGuard';
import { ProposalCard } from './ProposalCard';
import { ChatMessage } from './ChatMessage';
import { ToolGroupRow } from './ToolGroupRow';
import { groupMessages } from './message-groups';
import { ChatComposer, type ChatMode, type RefItem } from './ChatComposer';
import { loadAgentSettings } from '../../agent/settings/agentSettings';
import { BrandMark, CutaiWordmark, Icon } from '../icons';
import {
  clearComposerDraft,
  loadChatAutoApply,
  loadChatMode,
  loadComposerDraft,
  saveChatAutoApply,
  saveChatMode,
  saveComposerDraft,
} from '../../persist/sessionPrefs';

const EMPTY_PROJECT_STARTERS = [
  { label: '口播净剪', description: '去停顿、赘词并同步字幕', prompt: '精剪当前口播：去掉无效停顿和赘词，并生成同步字幕', icon: 'scissors' as const },
  { label: '动态包装', description: '标题、数据卡与转场动效', prompt: '为当前内容设计动态包装，包含标题、信息卡和转场动效', icon: 'film' as const },
  { label: '长片拆条', description: '提炼高光并重排为短视频', prompt: '从当前长视频中提炼高光，重排成适合发布的短视频', icon: 'video' as const },
  { label: '产品故事', description: '围绕卖点组织脚本和镜头', prompt: '围绕产品卖点组织脚本和镜头，制作一支产品宣传短片', icon: 'sparkles' as const },
  { label: 'AI 影像', description: '从概念生成镜头与声音', prompt: '根据我的概念策划一支 AI 影像，补全镜头、声音和节奏', icon: 'image' as const },
  { label: '知识成片', description: '把主题整理成清晰讲解', prompt: '把主题整理成结构清晰、带字幕和视觉提示的讲解视频', icon: 'play' as const },
];

const QUICK_ACTIONS = [
  { label: '删除填充词', prompt: '删除当前口播中的填充词，并保持字幕与画面同步' },
  { label: '删除静音', prompt: '删除当前时间线中的静音停顿，并收紧空隙' },
  { label: '跳切', prompt: '把当前口播剪成节奏紧凑的跳切版本' },
  { label: '生成字幕', prompt: '为当前口播生成并应用同步字幕' },
  { label: '响度标准化', prompt: '将当前时间线中的人声音量标准化' },
  { label: '横转竖', prompt: '将当前工程转换为 9:16 竖屏，并调整主要画面构图' },
];

const CHAT_DOCUMENT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'srt', 'vtt', 'log']);
const MAX_CHAT_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_CHAT_DOCUMENT_CHARS = 200_000;

function isChatDocument(file: File): boolean {
  const extension = file.name.toLowerCase().split('.').pop() || '';
  return CHAT_DOCUMENT_EXTENSIONS.has(extension)
    || file.type.startsWith('text/')
    || file.type === 'application/json';
}

async function readChatDocument(file: File): Promise<string> {
  if (file.size > MAX_CHAT_DOCUMENT_BYTES) {
    throw new Error(`文档“${file.name}”超过 2 MB，请拆分后再附加`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('gb18030').decode(bytes);
  }
  text = text.replace(/^\uFEFF/, '');
  if (text.length > MAX_CHAT_DOCUMENT_CHARS) {
    throw new Error(`文档“${file.name}”内容超过 20 万字，请拆分后再附加`);
  }
  return text;
}

interface ChatPanelProps {
  ctx: AgentContext;
  /** the current project's id — chat history is persisted per project */
  projectId: string;
  projectRoot?: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** show a proposal's draft result in the player (null = show committed state) */
  onPreviewState: (state: TimelineState | null) => void;
  /** prefill the composer (library「用 AI 生成」); bump the number to re-seed */
  seed?: { text: string; nonce: number; reference?: RefItem } | null;
  /** active creative-mode skill id (agent_skill), or null */
  creativeMode: string | null;
  onCreativeModeChange: (id: string | null) => void;
  /** Import a pasted/attached file into the media pool (same pipeline as 我的素材 upload). */
  onImportMedia: (file: File) => Promise<MediaAsset>;
  /** Pull a directly edited .cutai/project.json into the open editor. */
  onWorkspaceEdited?: () => Promise<boolean>;
}

// 运行计时:AI 思考/执行期间实时跳动的秒数(保留两位小数)。挂载即起表,
// 随 running 指示行卸载;一位小数 100ms 刷新即可,tabular-nums 防抖动。
function ElapsedTimer() {
  const [now, setNow] = useState(() => performance.now());
  const startRef = useRef(performance.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(id);
  }, []);
  const secs = Math.max(0, (now - startRef.current) / 1000);
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.75, flexShrink: 0 }}>
      {secs.toFixed(1)}s
    </span>
  );
}

// 前置 skill_guard 卡上的技能中文名(受 gate 的 3 个生成技能)
const GUARD_SKILL_LABELS = {
  'image-gen': '图像生成',
  'motion-graphic-gen': 'MG 动画生成',
  'video-gen': '视频生成',
} as const;

export function ChatPanel({ ctx, projectId, projectRoot, collapsed, onToggleCollapse, onPreviewState, seed, creativeMode, onCreativeModeChange, onImportMedia, onWorkspaceEdited }: ChatPanelProps) {
  const t = useT();
  const {
    messages: apiMessages, running: apiRunning, send: sendApi, stop: stopApi, enhance, proposal, applyProposal, rejectProposal, clearHistory: clearApiHistory,
    proposalStale, forceApplyProposal, reProposeStale, pendingGuard, liveTool,
    changeLog, rollbackChangeSession, canRollbackChangeSession,
  } = useAgent(ctx, projectId);
  const sourceKey = `cutai:agent-source:${projectId}`;
  const cliChatKey = (profileId: string) => `cutai:cli-chat:${projectId}:${profileId}`;
  const [agentSource, setAgentSource] = useState(() => localStorage.getItem(sourceKey) || 'api');
  const [cliProfiles, setCliProfiles] = useState<CliAgentProfileResult[]>([]);
  const [cliMessages, setCliMessages] = useState<DisplayMessage[]>([]);
  const [cliRunning, setCliRunning] = useState(false);
  const [cliRunId, setCliRunId] = useState<string | null>(null);
  const cliRunIdRef = useRef<string | null>(null);
  const [cliSessionId, setCliSessionId] = useState<string | undefined>();
  useEffect(() => window.cutaiDesktop?.onCliAgentEvent((event) => {
    if (event.runId !== cliRunIdRef.current) return;
    setCliMessages((current) => {
      const next = [...current];
      const ensureAssistant = (): number => {
        const last = next[next.length - 1];
        if (last?.role !== 'assistant') next.push({ role: 'assistant', text: '', thinking: '' });
        return next.length - 1;
      };
      const updateAssistant = (patch: (message: DisplayMessage) => DisplayMessage, newSegment = false): void => {
        const assistantIndex = newSegment || next[next.length - 1]?.role !== 'assistant'
          ? ensureAssistant()
          : next.length - 1;
        next[assistantIndex] = patch(next[assistantIndex]);
      };
      if (event.type === 'status') {
        updateAssistant((message) => {
          const lifecyclePlaceholder = !message.thinking
            || message.thinking.includes('等待结构化事件')
            || message.thinking.includes('正在建立原生流式会话');
          if (!lifecyclePlaceholder || message.text) return message;
          return { ...message, thinking: event.message };
        });
      } else if (event.type === 'thinking') {
        updateAssistant((message) => ({
          ...message,
          thinking: `${message.thinking
            && !message.thinking.includes('等待结构化事件')
            && !message.thinking.includes('正在建立原生流式会话')
            ? message.thinking : ''}${event.delta}`,
        }));
      } else if (event.type === 'text') {
        updateAssistant((message) => ({ ...message, text: `${message.text}${event.delta}` }));
      } else if (event.type === 'tool-start') {
        next.push({
          role: 'tool',
          text: '',
          tool: { name: event.name, args: event.args ?? {}, result: { status: 'running', toolId: event.toolId } },
        });
      } else if (event.type === 'tool-result') {
        const toolIndex = next.findLastIndex((message) => message.role === 'tool'
          && message.tool?.result && typeof message.tool.result === 'object'
          && (message.tool.result as { toolId?: string }).toolId === event.toolId);
        if (toolIndex >= 0 && next[toolIndex].tool) {
          next[toolIndex] = {
            ...next[toolIndex],
            tool: { ...next[toolIndex].tool!, result: event.result ?? { status: 'completed' } },
          };
        } else {
          next.push({ role: 'tool', text: '', tool: { name: event.name, args: {}, result: event.result ?? { status: 'completed' } } });
        }
      }
      return next;
    });
  }), []);
  useEffect(() => {
    void window.cutaiDesktop?.listCliAgents().then(setCliProfiles).catch(() => setCliProfiles([]));
  }, []);
  useEffect(() => {
    localStorage.setItem(sourceKey, agentSource);
    if (agentSource === 'api') { setCliMessages([]); setCliSessionId(undefined); return; }
    try {
      const parsed = JSON.parse(localStorage.getItem(cliChatKey(agentSource)) || '{}') as {
        messages?: DisplayMessage[];
        sessionId?: string;
      };
      setCliMessages(Array.isArray(parsed.messages) ? parsed.messages : []);
      setCliSessionId(typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined);
    } catch {
      setCliMessages([]);
      setCliSessionId(undefined);
    }
  }, [agentSource, sourceKey]);
  useEffect(() => {
    if (agentSource === 'api' || cliRunning) return;
    localStorage.setItem(cliChatKey(agentSource), JSON.stringify({ messages: cliMessages, sessionId: cliSessionId }));
  }, [agentSource, cliMessages, cliSessionId, cliRunning]);
  const sendCli = async (text: string, references: AgentReference[] = []): Promise<void> => {
    const desktop = window.cutaiDesktop;
    const profile = cliProfiles.find((item) => item.id === agentSource);
    if (!desktop || !profile) {
      setCliMessages((current) => [...current, { role: 'error', text: t('CLI Agent 不可用') }]);
      return;
    }
    if (!projectRoot) {
      setCliMessages((current) => [...current, { role: 'user', text }, {
        role: 'error',
        text: t('CLI Agent 只在本地文件夹工程中启用。请先把当前工程迁移到本地文件夹。'),
      }]);
      return;
    }
    let liveProfile = profile;
    if (!profile.authorizedRoots.includes(projectRoot)) {
      const approved = window.confirm([
        t('首次启用本地 CLI Agent，需要授权只读访问当前工程。'),
        '',
        `${t('Agent')}：${profile.name} ${profile.version}`,
        `${t('可执行文件')}：${profile.executable}`,
        `${t('配置目录')}：${profile.configDirectory || '-'}`,
        `${t('工程目录')}：${projectRoot}`,
        t('权限：读取工程文件；禁止直接写源素材和 .cutai；时间线编辑必须通过 CutAI 提案确认。'),
      ].join('\n'));
      if (!approved) return;
      await desktop.authorizeCliAgent(profile.id, projectRoot, profile.fingerprint);
      const refreshed = await desktop.listCliAgents();
      setCliProfiles(refreshed);
      liveProfile = refreshed.find((item) => item.id === profile.id) ?? profile;
    }
    const runId = crypto.randomUUID();
    cliRunIdRef.current = runId;
    setCliRunId(runId);
    setCliRunning(true);
    setCliMessages((current) => [...current, { role: 'user', text }, {
      role: 'assistant',
      text: '',
      thinking: 'CLI 已启动，正在等待结构化事件…',
    }]);
    try {
      const contextEntries = resolveAgentReferences(ctx, references);
      const prompt = contextEntries.length
        ? `${text}\n\n<chat_context_entries>\n${JSON.stringify(contextEntries)}\n</chat_context_entries>`
        : text;
      const model = localStorage.getItem(`cutai:cli-model:${projectId}:${liveProfile.id}`) || liveProfile.defaultModel;
      const sessionModelKey = `cutai:cli-session-model:${projectId}:${liveProfile.id}`;
      const sessionModel = localStorage.getItem(sessionModelKey);
      const modelChanged = Boolean(cliSessionId && sessionModel && sessionModel !== model);
      const conversationBridge = modelChanged
        ? cliMessages
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .slice(-12)
          .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
          .join('\n\n')
        : '';
      const effectivePrompt = conversationBridge
        ? `<conversation_context_from_previous_model>\n${conversationBridge}\n</conversation_context_from_previous_model>\n\n${prompt}`
        : prompt;
      const selectedModel = liveProfile.models.find((item) => item.id === model);
      const reasoningEffort = localStorage.getItem(`cutai:cli-effort:${projectId}:${liveProfile.id}`)
        || selectedModel?.defaultReasoningEffort;
      const agentSettings = loadAgentSettings();
      const selectedFileAccess = localStorage.getItem(`cutai:cli-file-access:${projectId}:${liveProfile.id}`) === 'workspace-write'
        ? 'workspace-write' as const
        : 'proposal-only' as const;
      const fileAccess = agentSettings.planMode ? 'proposal-only' as const : selectedFileAccess;
      const result = await desktop.runCliAgent({
        runId,
        profileId: liveProfile.id,
        projectId,
        projectRoot,
        prompt: effectivePrompt,
        // Claude/Codex keep the model on a resumed native thread. Start a new
        // thread when the user changes model; otherwise the UI selection is
        // silently ignored by the provider.
        ...(cliSessionId && sessionModel === model ? { sessionId: cliSessionId } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort: reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
        fileAccess,
        planMode: agentSettings.planMode,
      });
      if (fileAccess === 'workspace-write' && onWorkspaceEdited) {
        await onWorkspaceEdited();
      }
      setCliSessionId(result.sessionId);
      if (model) localStorage.setItem(sessionModelKey, model);
      setCliMessages((current) => {
        const next = [...current];
        const assistantIndex = next.findLastIndex((message) => message.role === 'assistant');
        if (assistantIndex < 0) {
          next.push({ role: 'assistant', text: result.text || t('CLI 已完成，但没有返回文本。'), ...(result.reasoning ? { thinking: result.reasoning } : {}) });
        } else {
          const assistant = next[assistantIndex];
          next[assistantIndex] = {
            ...assistant,
            text: assistant.text || result.text || t('CLI 已完成，但没有返回文本。'),
            thinking: assistant.thinking?.includes('等待结构化事件') ? result.reasoning : assistant.thinking || result.reasoning,
          };
        }
        return next;
      });
    } catch (error) {
      setCliMessages((current) => [...current, {
        role: 'error',
        text: error instanceof Error ? error.message : String(error),
      }]);
    } finally {
      cliRunIdRef.current = null;
      setCliRunId(null);
      setCliRunning(false);
    }
  };
  const messages = agentSource === 'api' ? apiMessages : cliMessages;
  const running = agentSource === 'api' ? apiRunning : cliRunning;
  const send = (text: string, options?: { askOnly?: boolean; references?: AgentReference[] }): void => {
    if (agentSource === 'api') sendApi(text, options);
    else void sendCli(text, options?.references);
  };
  const stop = (): void => {
    if (agentSource === 'api') stopApi();
    else if (cliRunId) void window.cutaiDesktop?.cancelCliAgent(cliRunId);
  };
  const clearHistory = (): void => {
    if (agentSource === 'api') clearApiHistory();
    else {
      setCliMessages([]);
      setCliSessionId(undefined);
      localStorage.removeItem(cliChatKey(agentSource));
    }
  };
  const externalProposal = useExternalAgentBridge(ctx, projectId);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<ChatMode>('agent');
  const [autoApply, setAutoApply] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [selectedRefs, setSelectedRefs] = useState<RefItem[]>([]);
  // Restore composer draft / mode when switching projects (session continuity).
  useEffect(() => {
    setInput(loadComposerDraft(projectId));
    setMode(loadChatMode(projectId));
    setAutoApply(loadChatAutoApply(projectId));
    setSelectedRefs([]);
  }, [projectId]);
  // Debounced draft persist — empty clears the key.
  useEffect(() => {
    const id = window.setTimeout(() => saveComposerDraft(projectId, input), 350);
    return () => window.clearTimeout(id);
  }, [input, projectId]);
  useEffect(() => { saveChatMode(projectId, mode); }, [mode, projectId]);
  useEffect(() => { saveChatAutoApply(projectId, autoApply); }, [autoApply, projectId]);
  // 选择模式: panels pick clips/regions/words as refs
  const [selecting, setSelecting] = useState(false);
  const [pasting, setPasting] = useState(0);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // one film-crew "thinking…" phrase per running turn
  const runSeedRef = useRef(0);
  if (running && runSeedRef.current === 0) runSeedRef.current = messages.length + 1;
  if (!running) runSeedRef.current = 0;
  // 正在收 thinking(本轮助手气泡只有思考、还没正文)→ 底部指示换成微光「思考中…」;
  // 无 thinking 数据时保留原随机片场短语。
  const lastMsg = messages[messages.length - 1];
  const streamingThinking = running && lastMsg?.role === 'assistant' && !!lastMsg.thinking && !lastMsg.text;

  // @-referenceable things: media-pool assets + template library
  const references: RefItem[] = [
    ...ctx.getDoc().assets.map((a) => ({
      id: a.id, name: a.name, kind: a.kind, preview: a.src, width: a.width, height: a.height,
    })),
    ...ctx.templates.slice(0, 40).map((tpl) => ({
      id: tpl.id,
      name: tpl.name,
      kind: 'template' as const,
      preview: tpl.thumb || undefined,
      description: tpl.description,
      category: tpl.category,
      width: tpl.width,
      height: tpl.height,
    })),
  ];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, running, proposal]);

  // library「用 AI 生成」seeds the composer (attaches the template as a chat ref)
  useEffect(() => {
    if (seed && !collapsed) {
      setInput(seed.text);
      setSelectedRefs(seed.reference ? [seed.reference] : []);
      taRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);

  // clear any preview when the proposal is resolved (applied/rejected)
  useEffect(() => { if (!proposal) onPreviewState(null); }, [proposal, onPreviewState]);

  // 设置·自动应用: when on, apply the proposal (all ops) as soon as it arrives.
  // skill_guard: high-cost tools still require the proposal card.
  useEffect(() => {
    if (!proposal || !autoApply) return;
    if (shouldBlockAutoApply(proposal, autoApply)) return;
    const all = new Set(proposal.options[0].operations.map((_, i) => i));
    applyProposal(all);
  }, [proposal, autoApply, applyProposal]);

  const submit = () => {
    if (!input.trim() || running) return;
    send(input, { askOnly: mode === 'ask', references: selectedRefs });
    setInput('');
    setSelectedRefs([]);
    clearComposerDraft(projectId);
  };
  const runEnhance = async () => {
    if (!input.trim() || enhancing || running) return;
    setEnhancing(true);
    try { const improved = await enhance(input); setInput(improved); taRef.current?.focus(); }
    finally { setEnhancing(false); }
  };
  // Mention chips mirror into the text as their prompt token:
  // pool assets stay `@name`; selection picks use `@t[…]`/`@r[…]`/`@q[…]`/`@[…]`.
  const insertRef = (reference: RefItem) => {
    setSelectedRefs((current) => current.some((item) => item.id === reference.id) ? current : [...current, reference]);
    const token = refPromptToken(reference);
    setInput((v) => v.includes(token) ? v : `${v}${v && !v.endsWith(' ') ? ' ' : ''}${token} `);
  };
  const removeRef = (id: string) => {
    setSelectedRefs((current) => {
      const gone = current.find((r) => r.id === id);
      if (gone) {
        const escaped = refPromptToken(gone).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        setInput((v) => v.replace(new RegExp(`${escaped}\\s?`, 'g'), '').trimStart());
      }
      return current.filter((r) => r.id !== id);
    });
  };
  // Keep the cross-panel pick mode in sync with the toggle; force it off when
  // the panel collapses/unmounts so no orphaned crosshair lingers (selection
  // mode stays active across picks for 连续拾取).
  useEffect(() => {
    setSelectionRefMode(selecting && !collapsed);
    return () => setSelectionRefMode(false);
  }, [selecting, collapsed]);
  useEffect(() => { if (collapsed) setSelecting(false); }, [collapsed]);
  // Picks from Timeline / Preview / 文字稿 land as chips in the composer.
  const insertRefRef = useRef(insertRef);
  insertRefRef.current = insertRef;
  useEffect(() => onSelectionRef((reference) => insertRefRef.current(reference)), []);
  // Paste files straight into the composer: import each supported file into the
  // media pool (same pipeline as 我的素材 upload — probe + upload + auto-ASR) and
  // attach it as an @ reference so the agent can place it (chat_context_entry).
  const importPastedFiles = async (files: File[]) => {
    const supported = files.filter((file) => kindOf(file) !== null || isChatDocument(file));
    setPasteError(supported.length < files.length
      ? t('已忽略暂不支持的文件；当前支持媒体和 TXT / Markdown / CSV / JSON / 字幕文本')
      : null);
    for (const file of supported) {
      setPasting((n) => n + 1);
      try {
        if (isChatDocument(file)) {
          const text = await readChatDocument(file);
          insertRef({
            id: `document:${crypto.randomUUID()}`,
            name: file.name,
            kind: 'document',
            mimeType: file.type || 'text/plain',
            text,
          });
        } else {
          const asset = await onImportMedia(file);
          insertRef({ id: asset.id, name: asset.name, kind: asset.kind });
        }
      } catch (reason) {
        setPasteError(reason instanceof Error ? reason.message : t('导入失败'));
      } finally {
        setPasting((n) => n - 1);
      }
    }
  };

  if (collapsed) {
    return (
      <aside style={{ gridColumn: 1, gridRow: '2 / 5', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '10px 0', borderRight: `0.5px solid ${theme.border}`, background: theme.panel }}>
        <button onClick={onToggleCollapse} title={t('展开 OpenChatCut Agent')} style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 14 }}><span style={{ transform: 'rotate(-90deg)', display: 'inline-flex' }}><Icon name="chevronDown" size={14} /></span></button>
        <div className="cc-chat-collapsed-brand">OpenChatCut</div>
      </aside>
    );
  }

  return (
    <aside style={{ gridColumn: 1, gridRow: '2 / 5', display: 'flex', flexDirection: 'column', borderRight: `0.5px solid ${theme.border}`, background: theme.panel, minHeight: 0, minWidth: 0 }}>
      <div className="cc-chat-header">
        <div className="cc-chat-brand">
          <BrandMark size={20} />
          <span className="cc-chat-brand-copy">
            <CutaiWordmark width={102} />
            <small>{t('Agent 工作台')}</small>
          </span>
        </div>
        {messages.length > 0 && (
          <button onClick={clearHistory} disabled={running} title={t('清空对话')}
            style={{ background: 'none', border: 'none', color: theme.textDim, cursor: running ? 'default' : 'pointer', opacity: running ? 0.4 : 1, padding: 2, lineHeight: 0 }}>
            <Icon name="trash" size={14} />
          </button>
        )}
        <button onClick={onToggleCollapse} title={t('收起 OpenChatCut Agent')} style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 13 }}><span style={{ transform: 'rotate(90deg)', display: 'inline-flex' }}><Icon name="chevronDown" size={14} /></span></button>
      </div>

      {changeLog.length > 0 && (
        <details style={{ borderBottom: `0.5px solid ${theme.border}`, padding: '7px 12px', fontSize: 12 }}>
          <summary style={{ cursor: 'pointer', color: theme.textDim }}>
            {t('Agent 修改记录')}（{changeLog.length}）
          </summary>
          <div style={{ display: 'grid', gap: 8, maxHeight: 180, overflow: 'auto', paddingTop: 8 }}>
            {[...changeLog].reverse().map((session) => {
              const canRollback = !running && canRollbackChangeSession(session.id);
              return (
                <div key={session.id} style={{ border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: 8 }}>
                  <div style={{ color: theme.text, lineHeight: 1.4 }}>{session.summary}</div>
                  <div style={{ color: theme.textDim, fontSize: 11, marginTop: 2 }}>
                    {new Date(session.createdAt).toLocaleString()} · {session.operations.length} {t('项操作')}
                  </div>
                  {session.operations.map((operation, index) => (
                    <div key={`${session.id}:${index}`} style={{ color: theme.textDim, marginTop: 4 }}>
                      {operation.action} · {operation.target} · {operation.impact}
                    </div>
                  ))}
                  <button type="button" disabled={!canRollback}
                    title={canRollback ? t('恢复到这次 Agent 修改前') : t('工程后来已有其他修改')}
                    onClick={() => rollbackChangeSession(session.id)}
                    style={{ marginTop: 7, border: `0.5px solid ${theme.border}`, borderRadius: 5, padding: '4px 8px', background: 'transparent', color: canRollback ? theme.text : theme.textDim, cursor: canRollback ? 'pointer' : 'default', opacity: canRollback ? 1 : 0.5 }}>
                    {t('回滚此会话')}
                  </button>
                </div>
              );
            })}
          </div>
        </details>
      )}

      {/* messages */}
      <div ref={scrollRef} className={`cc-chat-messages${messages.length === 0 ? ' empty' : ''}`}>
        {messages.length === 0 && (
          <div className="cc-chat-onboarding">
            <div className="cc-chat-onboarding-kicker">{t('从这里开工')}</div>
            <h2>{t('从一个剪辑目标开始')}</h2>
            <p>{t('选择工作流，或直接描述你想得到的成片。')}</p>
            <div className="cc-chat-starter-list">
              {EMPTY_PROJECT_STARTERS.map((starter) => (
                <button key={starter.label} onClick={() => { setInput(t(starter.prompt)); requestAnimationFrame(() => taRef.current?.focus()); }}>
                  <span className="cc-chat-starter-icon"><Icon name={starter.icon} size={16} /></span>
                  <span className="cc-chat-starter-copy">
                    <strong>{t(starter.label)}</strong>
                    <small>{t(starter.description)}</small>
                  </span>
                  <span className="cc-chat-starter-arrow" aria-hidden="true">→</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {groupMessages(messages).map((item) =>
          item.kind === 'toolgroup' ? (
            <ToolGroupRow key={item.index} name={item.name} items={item.items} />
          ) : (
            <ChatMessage key={item.index} msg={item.msg}
              streaming={running && item.index === messages.length - 1 && item.msg.role === 'assistant'}
              onContinue={item.msg.role === 'continue' && item.index === messages.length - 1 && !running
                ? () => send('继续') : null}
              onWidgetSubmit={(answer) => { if (!running) send(answer, { askOnly: mode === 'ask' }); }} />
          ),
        )}
        {running && liveTool && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, margin: '9px 0', color: theme.textDim, fontSize: 12.5 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: theme.accent, flexShrink: 0, marginTop: 5, animation: 'cc-rec-pulse 1.2s ease-out infinite' }} />
            <span style={{ minWidth: 0, lineHeight: 1.45 }}>
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: 0.2 }}>{liveTool.name}</span>
              <span style={{ opacity: 0.8 }}> · {t('正在编写参数…')}</span>
              {liveTool.partial.length > 40 && (
                <span style={{ display: 'block', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, opacity: 0.55, overflowWrap: 'anywhere', maxHeight: 48, overflow: 'hidden' }}>
                  …{liveTool.partial.slice(-160)}
                </span>
              )}
            </span>
          </div>
        )}
        {running && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: theme.textDim, fontSize: 12.5, margin: '10px 0' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: theme.accent, animation: 'cc-rec-pulse 1.2s ease-out infinite', flexShrink: 0 }} />
            {streamingThinking ? (
              <>
                <style>{'@keyframes cc-think-glow{0%,100%{opacity:.4}50%{opacity:1}}'}</style>
                <span style={{ animation: 'cc-think-glow 1.4s ease-in-out infinite' }}>{t('思考中…')}</span>
              </>
            ) : (
              <>{t(thinkingPhrase(runSeedRef.current))}…</>
            )}
            <ElapsedTimer />
          </div>
        )}
        {proposal && (!autoApply || shouldBlockAutoApply(proposal, autoApply)) && (
          <ProposalCard proposal={proposal} onApply={applyProposal} onReject={rejectProposal}
            stale={proposalStale} onForceApply={forceApplyProposal} onRePropose={reProposeStale}
            onPreview={(on) => onPreviewState(on ? proposal.resultState : null)} />
        )}
        <ExternalProposalCard external={externalProposal} onPreviewState={onPreviewState} />
        {pendingGuard && (
          <div style={{ margin: '10px 0', padding: '10px 12px', border: `0.5px solid ${theme.border}`, borderRadius: 4, background: theme.panelAlt }}>
            <div style={{ fontSize: 12.5, color: theme.text, marginBottom: 8, lineHeight: 1.5 }}>
              {t('AI 请求运行生成技能：{name}', { name: t(GUARD_SKILL_LABELS[pendingGuard.skill]) })}
              <span style={{ color: theme.textDim }}>（{pendingGuard.tool}）</span>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => pendingGuard.resolve('allow-once')}
                style={{ border: `0.5px solid ${theme.accent}`, background: theme.accent, color: theme.onAccent, borderRadius: 6, padding: '5px 14px', fontSize: 12.5, cursor: 'pointer' }}>
                {t('仅本次允许')}
              </button>
              <button type="button" onClick={() => pendingGuard.resolve('allow-scope')}
                style={{ border: `0.5px solid ${theme.border}`, background: 'transparent', color: theme.text, borderRadius: 6, padding: '5px 14px', fontSize: 12.5, cursor: 'pointer' }}>
                {pendingGuard.skill === 'motion-graphic-gen' ? t('所有工程不再询问') : t('本工程不再询问')}
              </button>
              <button type="button" onClick={() => pendingGuard.resolve('deny')}
                style={{ border: `0.5px solid ${theme.border}`, background: 'transparent', color: theme.textDim, borderRadius: 6, padding: '5px 14px', fontSize: 12.5, cursor: 'pointer' }}>
                {t('拒绝')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* composer — minWidth:0 so narrow chat column can't force send-btn overflow */}
      <div style={{ padding: '12px 12px 12px 12px', borderTop: `0.5px solid ${theme.border}`, minWidth: 0, flexShrink: 0, boxSizing: 'border-box' }}>
        <select aria-label={t('快速操作')} value="" disabled={running}
          onChange={(event) => {
            if (event.target.value === '') return;
            const action = QUICK_ACTIONS[Number(event.target.value)];
            if (!action) return;
            setInput(t(action.prompt));
            requestAnimationFrame(() => taRef.current?.focus());
          }}
          style={{ width: '100%', marginBottom: 8, border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '6px 8px', background: theme.panelAlt, color: theme.text, fontSize: 12 }}>
          <option value="">{t('快速操作…')}</option>
          {QUICK_ACTIONS.map((action, index) => <option key={action.label} value={index}>{t(action.label)}</option>)}
        </select>
        <ChatComposer
          value={input} onChange={(value) => {
            setInput(value);
            setSelectedRefs((current) => current.filter((reference) => value.includes(refPromptToken(reference))));
          }} onSubmit={submit} onStop={stop}
          onEnhance={runEnhance} enhancing={enhancing} running={running}
          mode={mode} onModeChange={setMode}
          autoApply={autoApply} onAutoApplyChange={setAutoApply}
          selecting={selecting} onToggleSelecting={() => setSelecting((v) => !v)}
          creativeMode={creativeMode} onCreativeModeChange={onCreativeModeChange}
          references={references} onInsertRef={insertRef}
          selectedRefs={selectedRefs} onRemoveRef={removeRef}
          onPasteFiles={importPastedFiles} pasting={pasting > 0}
          pasteError={pasteError} onDismissPasteError={() => setPasteError(null)}
          taRef={taRef}
          agentSource={agentSource}
          cliProfiles={cliProfiles}
          projectRoot={projectRoot}
          projectId={projectId}
          onAgentSourceChange={setAgentSource}
          placeholder={messages.length === 0 ? t('描述你想要创建的内容...') : t('告诉 AI 要做哪些修改 - @ 引用素材')} />
      </div>
    </aside>
  );
}
