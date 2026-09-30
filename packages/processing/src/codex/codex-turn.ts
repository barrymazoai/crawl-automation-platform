import { open } from "node:fs/promises";
import { join } from "node:path";
import { runCodexTurn, type CodexRpc } from "@crawl-automation/platform";
import type { CodexClientSettings } from "./codex-settings.js";

export interface CodexCall {
  prompt: string;
  outputSchema: object;
  /** An image the model reads with the prompt, as its original file. */
  image?: { name: string; bytes: Uint8Array };
}

/** One app-server turn on an owned connection; an image is written into the call's own directory first. */
export async function runOwnedTurn(
  owned: { rpc: CodexRpc; cwd: string; settings: CodexClientSettings },
  call: CodexCall,
  signal: AbortSignal,
): Promise<string> {
  const { rpc, cwd, settings } = owned;
  const image = call.image
    ? { path: await writeImage(cwd, call.image), detail: "original" as const }
    : undefined;
  const turn = {
    ...settings.settings,
    cwd,
    prompt: call.prompt,
    outputSchema: call.outputSchema,
    ...(image ? { image } : {}),
  };
  return runCodexTurn(rpc, turn, { signal, timeoutMs: settings.timeoutMs });
}

/** Created new and readable only by this user. */
async function writeImage(
  cwd: string,
  image: { name: string; bytes: Uint8Array },
): Promise<string> {
  const path = join(cwd, image.name);
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(image.bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  return path;
}
