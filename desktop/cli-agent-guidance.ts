import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const GUIDE_VERSION = 1;
const GUIDE_DIR = join('.cutai', 'agent-guides');

export const CUTAI_AGENT_SYSTEM_PROMPT = [
  'You are the native Claude Code agent embedded in CutAI.',
  'For CutAI project or timeline work, follow .cutai/agent-guides/README.md.',
  'Read only the guide page relevant to the task plus .cutai/project.json; do not explore application source code, old sessions, audit logs, backups, or the web to rediscover the project format.',
  'When the request is clear, execute it immediately and finish with a concise Chinese delivery summary containing what changed, where it changed, validation performed, and any real blocker.',
  'For visual judgments about video content, do not infer from filenames, duration, transcript status, or project JSON alone. The native CLI session has no CutAI frame-inspection tool: if the source is not directly readable as a local file, report the exact source path and that visual inspection is unavailable, instead of asking vague clarification questions or claiming to have seen the footage.',
].join(' ');

const README = `<!-- cutai-agent-guide-v${GUIDE_VERSION} -->
# CutAI 原生 Agent 指引

本目录由 CutAI 生成，供内置 Claude Agent SDK 使用。它不是 MCP 配置。

## 每次任务的最短路径

1. 读取本文件。
2. 读取 \`.cutai/project.json\`；只在需要时间线结构时再读 \`project-format.md\`，需要手写 MG 时再读 \`motion-graphics.md\`。
3. 用户要求明确时直接修改，不要遍历应用源码、旧会话、审计、备份或联网搜索格式。
4. 保持 \`.cutai/project.json\` 为严格 JSON。只修改用户要求的字段，不改源媒体。
5. 写入后重新读取并验证 JSON、轨道引用、帧范围和素材引用。
6. 最终用简短中文交付：改了什么、时间点/对象、验证结果、真实阻塞。

## 任务判断

- 问答/分析：只读，不修改工程。
- 时间线、字幕、MG、轨道、画布修改：编辑 \`.cutai/project.json\`。
- 普通项目文件任务：编辑用户指定文件，不碰 \`.cutai/project.json\`。
- 源媒体缺失：不要伪造或改写为不存在的路径；明确报告需要重新导入或重连。

## 交付纪律

- 不把“已写 JSON”等同于完成；必须验证 CutAI 能校验并载入该工程。
- 不输出长篇内部推理或工具清单。
- 不声称看过画面，除非任务中确实获得了可用帧或预览证据。
- 不引入 MCP、ChatCut 或外部转换层。
`;

const PROJECT_FORMAT = `<!-- cutai-agent-guide-v${GUIDE_VERSION} -->
# project.json 格式与不变量

CutAI 当前持久化版本为 \`version: 3\`。

\`\`\`json
{
  "version": 3,
  "assets": [],
  "mediaFolders": [],
  "timelines": [{
    "id": "timeline_id",
    "name": "主时间线",
    "order": 0,
    "fps": 30,
    "width": 1920,
    "height": 1080,
    "items": [],
    "selectedId": null,
    "trackOrder": ["track_v1"],
    "tracks": { "track_v1": { "kind": "video" } }
  }],
  "activeTimelineId": "timeline_id"
}
\`\`\`

## TimelineItem 最小字段

\`id\`、\`track\`、\`startFrame\`、\`durationInFrames\`、\`name\`、\`kind\`。

- 媒体项：\`kind\` 为 \`video|audio|image|gif|svg\`，保留已有 \`src\`，可有 \`srcInFrame\`、\`volume\`、\`playbackRate\`。
- MG：\`kind: "motion-graphic"\`，需要 \`code\`、\`props\`，通常带 \`width\`、\`height\`。
- 纯文字/色块：\`kind: "text"|"solid"\`，沿用工程中已有项的字段形状。

## 必须保持

- \`activeTimelineId\` 必须引用现有 timeline。
- 每个 item 的 \`track\` 必须存在于 \`tracks\`，并出现在 \`trackOrder\`。
- \`startFrame >= 0\`，\`durationInFrames > 0\`；单位始终是帧，秒数乘 timeline.fps。
- ID 在对应集合中唯一。
- 不把 \`assets\` 塞进 timeline；素材池属于项目顶层。
- 不改写已有媒体 \`src\`，除非用户明确提供了可验证的新源。
- 新视觉叠加轨应放在承载视频的轨道上方；遵循当前 \`trackOrder\` 的现有方向，不凭别名猜稳定 ID。
- 修改前保留未涉及的顶层字段、timeline 字段、item 字段。

## 快速验证

1. JSON 可解析。
2. 所有 timeline/item/track ID 引用有效。
3. 项目至少保留一条 timeline；活动 timeline 存在。
4. 新片段落在预期帧区间，不无意覆盖或延长工程。
5. 媒体源缺失时明确报告，不伪造完成。
`;

const MOTION_GRAPHICS = `<!-- cutai-agent-guide-v${GUIDE_VERSION} -->
# 手写 Motion Graphic

只有在用户要求 MG 且现有工程没有可复用项时才手写。代码保存到 timeline item 的 \`code\` 字符串中。

## 运行契约

- 形状：\`const Name = ({ item }) => { ...; return (<AbsoluteFill>...</AbsoluteFill>); };\`
- 不写 import、require、export。
- 已注入：\`React\`、\`useCurrentFrame\`、\`useVideoConfig\`、\`interpolate\`、\`interpolateColors\`、\`spring\`、\`Easing\`、\`random\`、\`Img\`、\`Video\`、\`Audio\`、\`Sequence\`、\`AbsoluteFill\`、\`staticFile\`。
- 文案、颜色、数值优先来自 \`item.props\`，不要把旧模板残留文案写死。
- \`interpolate\` 的 inputRange 必须严格递增；计算断点时保证后一项至少比前一项大 1。
- 使用 \`useVideoConfig()\` 的 fps 和 durationInFrames；不要假定 30fps。
- 默认做透明 overlay。只有用户明确要求章节页/全屏卡时才铺满不透明背景。

## 最小示例

\`\`\`jsx
const CutaiTitle = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const props = item.props || {};
  const enter = spring({ frame, fps, config: { damping: 18, stiffness: 120 } });
  const exitStart = Math.max(1, durationInFrames - Math.round(fps * 0.4));
  const opacity = interpolate(
    frame,
    [0, Math.max(1, Math.round(fps * 0.2)), exitStart, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', padding: 80, pointerEvents: 'none' }}>
      <div style={{
        opacity,
        transform: \`translateY(\${(1 - enter) * 24}px)\`,
        color: props.color || '#fff',
        fontSize: 64,
        fontWeight: 700
      }}>
        {props.text || '标题'}
      </div>
    </AbsoluteFill>
  );
};
\`\`\`

## MG 验收

- 代码字符串非空且可由 CutAI 模板宿主编译。
- props 与代码读取的键一致。
- 文字在播放尺寸下可读，overlay 不遮挡主体/字幕区域。
- 同类 MG 复用视觉语言；不要连续堆叠全屏卡。
`;

async function writeIfChanged(path: string, content: string): Promise<void> {
  try {
    if (await readFile(path, 'utf8') === content) return;
  } catch {
    // First creation.
  }
  await writeFile(path, content, 'utf8');
}

export async function ensureCutaiAgentGuides(projectRoot: string): Promise<string> {
  const directory = resolve(projectRoot, GUIDE_DIR);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeIfChanged(join(directory, 'README.md'), README),
    writeIfChanged(join(directory, 'project-format.md'), PROJECT_FORMAT),
    writeIfChanged(join(directory, 'motion-graphics.md'), MOTION_GRAPHICS),
  ]);
  return directory;
}
