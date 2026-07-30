export function hasToolResultError(result: unknown): result is Record<string, unknown> {
  return result !== null && typeof result === 'object' && 'error' in result;
}
