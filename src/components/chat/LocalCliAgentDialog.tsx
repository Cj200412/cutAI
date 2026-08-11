import { useEffect, useState } from 'react';
import { theme } from '../../theme';

interface LocalCliAgentDialogProps {
  open: boolean;
  profiles: readonly CliAgentProfileResult[];
  projectRoot?: string;
  onClose: () => void;
  onProfilesChanged: (profiles: CliAgentProfileResult[]) => void;
}

interface FormState {
  name: string;
  executable: string;
  argsText: string;
  envText: string;
  timeoutSeconds: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  executable: '',
  argsText: '',
  envText: '',
  timeoutSeconds: '10',
  enabled: true,
};

function formFor(profile: CliAgentProfileResult): FormState {
  return {
    name: profile.name,
    executable: profile.executable,
    argsText: (profile.args ?? []).join('\n'),
    envText: (profile.envAllowlist ?? []).join('\n'),
    timeoutSeconds: String(Math.round((profile.startupTimeoutMs ?? 10_000) / 1_000)),
    enabled: profile.reason !== '已停用',
  };
}

function inputFor(form: FormState): CustomCliAgentInputResult {
  return {
    name: form.name.trim(),
    executable: form.executable.trim(),
    args: form.argsText.split(/\r?\n/).filter((value) => value.length > 0),
    envAllowlist: form.envText.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean),
    startupTimeoutMs: Number(form.timeoutSeconds) * 1_000,
    enabled: form.enabled,
  };
}

const fieldStyle = {
  width: '100%',
  boxSizing: 'border-box' as const,
  border: `1px solid ${theme.border}`,
  borderRadius: 5,
  background: theme.inset,
  color: theme.text,
  padding: '7px 8px',
  fontSize: 12,
};

export function LocalCliAgentDialog({ open, profiles, projectRoot, onClose, onProfilesChanged }: LocalCliAgentDialogProps) {
  const desktop = window.cutaiDesktop;
  const customProfiles = profiles.filter((profile) => profile.kind === 'custom-acp');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!open) return;
    const selected = profiles.find((profile) => profile.kind === 'custom-acp' && profile.id === selectedId);
    if (selected) setForm(formFor(selected));
    else if (selectedId) {
      setSelectedId(null);
      setForm(EMPTY_FORM);
    }
  }, [open, profiles, selectedId]);

  if (!open) return null;

  const refresh = async (): Promise<CliAgentProfileResult[]> => {
    const next = await desktop?.listCliAgents() ?? [];
    onProfilesChanged(next);
    window.dispatchEvent(new Event('cutai:cli-profiles-changed'));
    return next;
  };
  const perform = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setMessage('');
    try { await operation(); } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  };
  const chooseExecutable = (): void => {
    void perform(async () => {
      const path = await desktop?.chooseCliExecutable();
      if (path) setForm((current) => ({ ...current, executable: path }));
    });
  };
  const save = (): void => {
    void perform(async () => {
      if (!desktop) throw new Error('自定义 CLI 仅在桌面版可用');
      const saved = selectedId
        ? await desktop.updateCliAgent(selectedId, inputFor(form))
        : await desktop.createCliAgent(inputFor(form));
      setSelectedId(saved.id);
      await refresh();
      setMessage('已保存。请点击“测试 ACP 握手”，通过后才能在 Agent 列表中使用。');
    });
  };
  const probe = (): void => {
    void perform(async () => {
      if (!desktop || !selectedId) throw new Error('请先保存这个自定义 CLI');
      const result = await desktop.probeCliAgent(selectedId);
      await refresh();
      if (!result.compatible) throw new Error(result.reason || 'ACP 握手失败');
      setMessage(`握手成功：${result.version || 'ACP v1'}；${result.supportsHttpMcp ? '支持 CutAI HTTP MCP' : '不支持 HTTP MCP，只能问答'}`);
    });
  };
  const remove = (): void => {
    if (!selectedId || !window.confirm('删除这个自定义 CLI 配置？已授权记录也会删除。')) return;
    void perform(async () => {
      await desktop?.deleteCliAgent(selectedId);
      setSelectedId(null);
      setForm(EMPTY_FORM);
      await refresh();
      setMessage('已删除。');
    });
  };
  const revoke = (): void => {
    if (!selectedId || !projectRoot) return;
    void perform(async () => {
      await desktop?.revokeCliAgent(selectedId, projectRoot);
      await refresh();
      setMessage('已撤销当前工程授权。');
    });
  };
  const selected = customProfiles.find((profile) => profile.id === selectedId);

  return <div role="dialog" aria-modal="true" aria-label="自定义 ACP CLI"
    style={{ position: 'fixed', inset: 0, zIndex: 10020, background: 'rgba(0,0,0,.58)', display: 'grid', placeItems: 'center', padding: 24 }}>
    <div style={{ width: 'min(860px, 92vw)', maxHeight: '86vh', overflow: 'auto', border: `1px solid ${theme.border}`, borderRadius: 9, background: theme.panel, color: theme.text, boxShadow: '0 20px 70px rgba(0,0,0,.4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 16px', borderBottom: `1px solid ${theme.border}` }}>
        <div><strong>自定义 Agent CLI</strong><div style={{ fontSize: 11, color: theme.textDim, marginTop: 3 }}>协议：ACP v1 · stdio（每行一个 JSON-RPC 消息）</div></div>
        <button type="button" onClick={onClose} style={{ border: 0, background: 'transparent', color: theme.textDim, cursor: 'pointer', fontSize: 20 }}>×</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '230px minmax(0, 1fr)', minHeight: 430 }}>
        <aside style={{ borderRight: `1px solid ${theme.border}`, padding: 10 }}>
          <button type="button" onClick={() => { setSelectedId(null); setForm(EMPTY_FORM); setMessage(''); }}
            style={{ width: '100%', padding: '8px 10px', marginBottom: 8, border: `1px dashed ${theme.borderLight}`, borderRadius: 5, background: 'transparent', color: theme.accent, cursor: 'pointer' }}>＋ 新建 ACP CLI</button>
          {customProfiles.map((profile) => <button key={profile.id} type="button" onClick={() => { setSelectedId(profile.id); setForm(formFor(profile)); setMessage(''); }}
            style={{ width: '100%', padding: '9px 10px', marginBottom: 5, textAlign: 'left', border: 0, borderRadius: 5, background: selectedId === profile.id ? theme.panelAlt : 'transparent', color: theme.text, cursor: 'pointer' }}>
            <strong style={{ display: 'block', fontSize: 12 }}>{profile.name}</strong>
            <small style={{ color: profile.compatible ? theme.success : theme.textDim }}>{profile.compatible
              ? `${profile.version || '可用'} · ${profile.supportsHttpMcp ? 'CutAI MCP' : '仅问答（无 HTTP MCP）'}`
              : profile.reason || '不可用'}</small>
          </button>)}
          {!customProfiles.length && <div style={{ padding: 10, color: theme.textDim, fontSize: 11, lineHeight: 1.6 }}>还没有自定义 CLI。请提供一个实现 ACP v1 stdio 的可执行程序。</div>}
        </aside>
        <main style={{ padding: 16 }}>
          <div style={{ padding: '9px 10px', marginBottom: 13, borderRadius: 5, background: theme.panelAlt, color: theme.textDim, fontSize: 11, lineHeight: 1.55 }}>
            ACP 是通信协议，不是系统沙箱。程序以当前 Windows 用户权限运行，理论上可能访问工程外文件。CutAI 会传入 PATH、SystemRoot、用户/临时目录和语言等基础运行环境，再加上下方列出的额外变量；代理与 CA 变量也必须显式列出。时间线写入仍强制进入人工审核提案。参数会明文保存，请勿把 API Key 写进参数，优先使用 CLI 自己的安全登录配置。
          </div>
          <label style={{ display: 'block', marginBottom: 10, fontSize: 11 }}>名称
            <input aria-label="CLI 名称" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} style={{ ...fieldStyle, marginTop: 4 }} placeholder="例如：Gemini ACP" />
          </label>
          <label style={{ display: 'block', marginBottom: 10, fontSize: 11 }}>可执行文件（必须填写完整绝对路径）
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}><input aria-label="CLI 可执行文件" value={form.executable} onChange={(event) => setForm({ ...form, executable: event.target.value })} style={fieldStyle} placeholder="C:\\Tools\\agent.exe" />
              <button type="button" disabled={busy} onClick={chooseExecutable} style={{ minWidth: 70, border: `1px solid ${theme.border}`, borderRadius: 5, background: theme.panelAlt, color: theme.text, cursor: 'pointer' }}>浏览…</button></div>
          </label>
          <label style={{ display: 'block', marginBottom: 10, fontSize: 11 }}>启动参数（每行一个参数；不会经 shell 拼接）
            <textarea aria-label="CLI 启动参数" value={form.argsText} onChange={(event) => setForm({ ...form, argsText: event.target.value })} style={{ ...fieldStyle, marginTop: 4, minHeight: 72, resize: 'vertical' }} placeholder={'--acp\n--stdio'} />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 10 }}>
            <label style={{ display: 'block', marginBottom: 10, fontSize: 11 }}>额外允许继承的环境变量名（逗号或换行分隔；代理/CA 也需列出）
              <textarea aria-label="CLI 环境变量白名单" value={form.envText} onChange={(event) => setForm({ ...form, envText: event.target.value })} style={{ ...fieldStyle, marginTop: 4, minHeight: 54, resize: 'vertical' }} placeholder="GEMINI_API_KEY" />
            </label>
            <label style={{ display: 'block', marginBottom: 10, fontSize: 11 }}>握手超时（秒）
              <input aria-label="CLI 握手超时" type="number" min={1} max={60} value={form.timeoutSeconds} onChange={(event) => setForm({ ...form, timeoutSeconds: event.target.value })} style={{ ...fieldStyle, marginTop: 4 }} />
            </label>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, marginBottom: 12 }}><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />启用此配置</label>
          {message && <div role="status" style={{ color: /失败|错误|不存在|Invalid|incompatible/.test(message) ? theme.danger : theme.success, fontSize: 11, marginBottom: 10, whiteSpace: 'pre-wrap' }}>{message}</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
            <button type="button" disabled={busy} onClick={save} style={{ border: 0, borderRadius: 5, padding: '7px 12px', background: theme.accent, color: theme.onAccent, cursor: 'pointer' }}>{selectedId ? '保存修改' : '保存新配置'}</button>
            <button type="button" disabled={busy || !selectedId} onClick={probe} style={{ border: `1px solid ${theme.border}`, borderRadius: 5, padding: '7px 12px', background: theme.panelAlt, color: theme.text, cursor: 'pointer' }}>测试 ACP 握手</button>
            {selected?.authorizedRoots.includes(projectRoot ?? '') && <button type="button" disabled={busy} onClick={revoke} style={{ border: `1px solid ${theme.border}`, borderRadius: 5, padding: '7px 12px', background: 'transparent', color: theme.textDim, cursor: 'pointer' }}>撤销当前工程授权</button>}
            {selectedId && <button type="button" disabled={busy} onClick={remove} style={{ marginLeft: 'auto', border: `1px solid ${theme.danger}`, borderRadius: 5, padding: '7px 12px', background: 'transparent', color: theme.danger, cursor: 'pointer' }}>删除</button>}
          </div>
        </main>
      </div>
    </div>
  </div>;
}
