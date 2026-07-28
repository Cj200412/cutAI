# CutAI 本地工程与 CLI Agent 使用说明

## 创建或打开工程

- 推荐入口：主页点击“新建本地工程”，选择一个文件夹。CutAI 会在该文件夹内创建 `.cutai`，素材继续保留在原位置。
- 打开已有工程：点击“打开本地工程”，选择包含 `.cutai/manifest.json` 的文件夹。
- 快速体验：点击“临时工程”。此模式保存在应用内部，不允许本地 CLI 读取文件。
- 旧数据库工程可在工程卡片菜单中选择“迁移到本地文件夹”。成功前不会删除旧数据。
- 旧目录式 `.cutai` 工程仍可通过“打开旧工程包”只读导入。

本地工程的元数据布局：

```text
<工程目录>/.cutai/
  manifest.json
  project.json
  media-index.json
  autosave/
  audit/
  sessions/
```

CutAI 会索引工程目录中的视频、音频、图片和字幕，忽略 `.cutai`、`.git`、`node_modules`、隐藏缓存目录和越出根目录的符号链接。时间线保存采用原子替换，并保留 `project.json.bak`。

## 使用 Claude CLI 或 Codex CLI

1. 打开一个“本地工程”。
2. 在左侧 Agent 工作台的“Agent 来源”中选择“Claude CLI”或“Codex CLI”。
3. 首次使用时核对可执行文件、版本、适配器、配置目录、工程目录和权限，确认一次即可。
4. 直接输入任务。CutAI 复用 CLI 自己已有的登录状态，不要求再次输入 API Key。

每个工程会记住最后选择的 Agent。CLI 会话按工程和 CLI 分开保存，可继续、取消或重新开始。

## 安全边界

- Claude 使用结构化 `stream-json` 与计划模式；Codex 使用 JSONL 与 `read-only` 沙箱。
- 不解析彩色终端文本，也不通过 PowerShell、`cmd.exe` 或 shell 字符串启动 CLI。
- CLI 不能直接修改 `.cutai/project.json`、时间线或源媒体。
- Windows 沙箱拒绝直接读取时，CLI 可使用带短期工程 Token 的 CutAI MCP 只读工具；工具拒绝工程外路径、`.cutai` 元数据和二进制媒体文本读取。
- 时间线编辑必须先形成 CutAI 编辑提案。界面展示结构化差异，用户批准后才由 EditorCore 提交，并生成可撤销记录。
- 授权记录写入 `.cutai/audit/cli-authorizations.jsonl`；会话记录写入 `.cutai/sessions/<profile>.jsonl`。
- CLI 路径、版本或二进制摘要变化后，必须重新确认授权。

## 开发验证

```powershell
npm.cmd run build
npm.cmd run verify:workspace-project
npm.cmd run verify:cli-agent
npm.cmd run verify:cli-agent:live
npm.cmd run desktop:smoke
```

`verify:cli-agent:live` 会实际调用本机 Claude CLI 和 Codex CLI，读取测试工程文件，并验证结构化输出和可续接 session。
