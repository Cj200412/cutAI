import assert from 'node:assert/strict';
import { capabilitiesPrompt, type CapabilityKey } from './capabilities.ts';

const allOff = {
  image: false,
  voice: false,
  video: false,
  music: false,
  sound: false,
  stock: false,
  transcription: false,
  sandbox: false,
  web: false,
} satisfies Record<CapabilityKey, boolean>;

const prompt = capabilitiesPrompt(allOff);
assert.match(prompt, /设置 → AI 生成 → 生图/);
assert.match(prompt, /设置 → AI 生成 → 配音 \/ TTS/);
assert.match(prompt, /设置 → 素材 · 转写 → 在线图库/);
assert.match(prompt, /设置 → 素材 · 转写 → 转写 \/ 口播剪辑/);
assert.match(prompt, /设置 → 增强工具 → 沙箱执行/);
assert.match(prompt, /设置 → 增强工具 → 网页抓取/);

console.log('capabilities.verify: ok (unconfigured tools include settings paths)');
