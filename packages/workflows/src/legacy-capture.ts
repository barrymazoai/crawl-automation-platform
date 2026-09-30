/** Replay-only routing for histories recorded before adapters supplied capture-mode-v1. */
const recordedBrowserChannels: ReadonlySet<string> = new Set(["wholefoods"]);
export const legacyBrowserCapture = (channel: string): boolean =>
  recordedBrowserChannels.has(channel);
