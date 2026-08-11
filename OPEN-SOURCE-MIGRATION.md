# CutAI 开源底座与 CLI Agent 渐进迁移

## 本轮默认方案（待用户确认）

不在现有分支原地删除并替换全部源码。当前工程已经包含时间线、工程迁移、撤销/重做、字幕、MG、Agent 工具、MCP、预览和导出链；一次性覆盖会同时失去可用功能和回滚路径。

默认采用可验证的渐进路线：

```text
Claude / Codex CLI
        ↓ MCP（项目绑定、提案、审核、撤销）
当前 ExternalBridgeRuntime → EditorCore / Remotion
        ↓ 未来抽取 EditorPort（稳定边界）
未来 MLT XML + melt CLI 适配器
```

本轮已完成第一层：桌面 CLI Agent 会获得项目级短期 MCP 地址，通过 MCP 调用当前编辑器工具；令牌强制绑定当前工程，CLI 结束即撤销。CLI 子进程仅继承白名单环境变量。普通工程文件以工程根目录为工作目录，并受提示词限制；当前 `workspace-write` 不是操作系统级根目录沙箱，不能把这项提示约束描述成强制隔离。

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

## 推荐迁移阶段

### 阶段 0：稳定 Agent 边界（本轮）

- CLI 不直接依赖某个编辑器工程 JSON。
- 时间线修改固定走 `CLI → MCP → 编辑会话 → 用户审核/应用`。
- MCP 令牌绑定当前工程并在运行结束后撤销。
- CLI 子进程只继承白名单环境变量。

### 阶段 1：中立时间线与 MLT 探针

- 在独立分支 `rewrite/mlt-cli` 开发，不覆盖当前可用分支。
- 定义中立时间线：轨道、片段、字幕、音频、转场、MG 占位、素材引用和帧率。
- 实现 `.cutai → 中立时间线 → MLT XML` 只读转换。
- 增加受控探针检查 `melt` 路径、版本、模块和硬件编码器；禁止 Agent 自由拼接 shell 命令。

当前开发机检查结果：未发现 `melt`，因此本轮没有伪造 MLT 实机渲染通过。

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
