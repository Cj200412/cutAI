# CutAI 开源底座与 CLI Agent 渐进迁移

## 本轮采用的方案

不在现有分支原地删除并替换全部源码。当前工程已经包含时间线、工程迁移、撤销/重做、字幕、MG、Agent 工具、MCP、预览和导出链；一次性覆盖会同时失去可用功能和回滚路径。

在约定等待时间内没有收到相反选择，因此本轮按推荐项采用可验证的渐进路线：

```text
Claude / Codex CLI ─┐
自定义 ACP stdio ───┴→ CliAgentHost → 短期项目令牌 → MCP
                                                ↓
                              ExternalBridgeRuntime → EditorCore / Remotion
                                                ↓
                                      NeutralTimelineV1
                                                ↓
                           实验性 MLT XML → melt CLI（CPU）
```

本轮已经完成 CLI 与后端替换的第一层边界：

- 桌面端支持 Claude、Codex，以及用户登记的 ACP stdio CLI；自定义 CLI 会先完成 ACP v1 `initialize` 握手，只有明确报告 HTTP MCP 能力时才获得 CutAI MCP 地址。
- MCP 令牌强制绑定当前工程和本轮权限；计划模式只读，编辑模式强制形成手动提案，不能由 CLI 绕过界面自动应用。
- 取消、超时或异常退出会撤销令牌、取消尚未派发的编辑调用，并清理本轮隔离草稿；正常完成则保留提案供用户审核。
- CLI 子进程仅继承允许的环境变量。普通工程文件以工程根目录为工作目录，并受提示词限制；ACP 是通信协议而不是沙箱，自定义 CLI 仍以当前 Windows 用户权限运行，`workspace-write` 也不是操作系统级根目录隔离。命令参数会以明文保存在本机配置中，不应把密钥写入参数。
- 已加入版本化 `NeutralTimelineV1`、可信本地素材解析、确定性 MLT XML 和受控 `melt` 子进程；探针与渲染器都只使用固定参数，不会执行用户提供的命令，也不会把“列出硬件编码器”误报成真实 GPU 渲染成功。Remotion 仍负责默认预览；现有自动导出链（浏览器优先、Remotion 兼容回退）仍为默认，MLT 只能由用户显式选择。

## 为什么不直接覆盖为 OpenCut

- OpenCut 当前主线采用 MIT，但官方状态页仍把 Editor API、MCP、Headless 和脚本页列为后续能力，不能直接承接现有 Agent 编辑闭环。
- OpenCut Classic 已归档，适合参考交互，不适合作为继续维护的生产底座。
- 当前 CutAI 使用 AGPL-3.0-or-later。AGPL 也是完整开源许可；如果目标是改为 MIT/Apache 等宽松许可，除非取得全部相关权利人的明确重许可，否则不能复制现有 AGPL 实现后仅修改许可证，需 clean-room 重建并逐项复核。
- MLT framework/library 采用 LGPLv2.1，`melt` 可执行程序采用 GPLv2，各模块还可能采用不同许可证；未来打包或分发前必须生成实际依赖与模块的许可证清单。

官方资料：

- OpenCut 状态与许可证：https://github.com/OpenCut-app/OpenCut#status
- OpenCut Classic：https://github.com/OpenCut-app/opencut-classic
- MLT / melt：https://www.mltframework.org/docs/melt/
- MLT XML：https://www.mltframework.org/docs/mltxml/
- MLT 许可证说明：https://www.mltframework.org/docs/copyrightpolicy/
- Agent Client Protocol：https://agentclientprotocol.com/
- ACP TypeScript SDK：https://github.com/agentclientprotocol/typescript-sdk

## 推荐迁移阶段

### 阶段 0：稳定 Agent 边界（本轮）

- [x] CLI 不直接依赖某个编辑器工程 JSON。
- [x] 时间线修改固定走 `CLI → MCP → 编辑会话 → 用户审核/应用`。
- [x] MCP 令牌绑定当前工程和权限，并在运行结束、取消或超时后撤销。
- [x] CLI 子进程只继承白名单环境变量。
- [x] 自定义 ACP CLI 支持新增、编辑、删除、握手测试、授权撤销和持久化；配置变化会使旧授权失效。
- [x] 取消链覆盖 CLI、MCP broker 和隔离编辑会话，不再让已超时的排队调用稍后复活。

### 阶段 1：中立时间线与实验性 MLT 导出

- [x] 定义版本化中立时间线：轨道、片段、字幕、音频、转场、MG 占位、素材引用、帧率和不支持能力的显式诊断。
- [x] 实现当前时间线状态到 `NeutralTimelineV1` 的只读转换。
- [x] 增加 `GET /api/export/backends/mlt/probe`，只使用固定参数检查 `melt` 路径、版本、模块和硬件编码器；禁止调用方拼接 shell 命令。
- [x] 实现 `NeutralTimelineV1 → MLT XML`、注册素材真实路径解析、CPU 线程限制、进度、超时、进程树终止、临时文件清理和结构化错误映射。
- [x] 增加显式的“实验性 MLT”导出入口；只接受 MP4/H.264、原分辨率和原帧率，并在字幕、MG、转场、变速、关键帧、视觉调整或缺失素材无法保真时拒绝执行。
- [x] 补齐实验性 MLT 服务端任务的用户取消入口；取消信号会贯穿素材预检和 `melt` 进程树，排队任务也可在启动前撤销。
- [ ] 在安装了可信 `melt` 的开发机上用真实媒体验证 CPU 编码；完成前不把 MLT 设为默认后端。
- [ ] 逐项验证 GPU 编码器后再单独开放 GPU，不能仅凭探针列出编码器就宣称可用。

当前开发机的真实探针结果为 `availability: not-found`；导出界面因此禁用实验性 MLT 并提示设置可信的 `MLT_MELT_PATH`。本轮的 fake `melt` 合同测试验证了参数、进度、任务取消、超时、进程树和清理，但没有声称真实 MLT 媒体渲染通过。首阶段只接受与画布尺寸完全相同、方形像素且无需缩放或裁切的本地 video/image，以及基础 audio；不支持项会在启动渲染前明确拒绝。

迁移前的稳定回滚点是远端标签 `legacy-agpl-2026-08-12`（提交 `6f18a44`）；实验性实现位于独立分支 `rewrite/mlt-cli-phase2`，不会覆盖稳定分支。

### 阶段 2：双后端验证

- 同一个最小工程同时走当前后端和 MLT：双视频轨、音频、时间字幕、转场、MG 覆盖层、中文路径。
- 验证单帧预览、整片导出、进度、取消和结构化错误。
- 未达到功能矩阵前，MLT 只能作为实验后端，不切换默认值。

### 阶段 3：可回滚切换

- 项目格式先做双写/双读验证，再允许按工程选择后端。
- 保留旧后端至少一个发布周期；出现不兼容时可切回。
- 只有迁移后的自动化测试和真实导出均通过，才讨论移除旧实现。

## 若目标必须是 MIT

若无法取得全部相关权利人的重许可，则另建新仓库或无共同源码的 clean-room 分支，以 OpenCut 为 UI/内核候选，逐项重做现有功能。达到以下最低矩阵前不替换当前应用：

- 工程打开/保存/迁移与中文路径
- 多轨拖放、排序、防误重叠、撤销/重做
- 可编辑字幕、转写和长视频分段
- MG、素材池、预览与导出
- CLI Agent、MCP 编辑会话、提案审核和取消
- Windows 桌面打包及真实媒体测试

这条路线许可证更宽松，但周期更长，并会经历阶段性功能倒退。
