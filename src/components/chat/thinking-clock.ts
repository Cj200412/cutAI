import type { DisplayMessage } from '../../agent/useAgent';

export function startThinkingClock(message: DisplayMessage, now = Date.now()): DisplayMessage {
  if (message.thinkingActive) return message;
  return { ...message, thinkingActive: true, thinkingStartedAt: now };
}

export function pauseThinkingClock(message: DisplayMessage, now = Date.now()): DisplayMessage {
  if (!message.thinkingActive) return message;
  return {
    ...message,
    thinkingActive: false,
    thinkingElapsedMs: (message.thinkingElapsedMs ?? 0)
      + (message.thinkingStartedAt ? Math.max(0, now - message.thinkingStartedAt) : 0),
    thinkingStartedAt: undefined,
  };
}
