import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../logger/create-logger.js";
import { describeCodexError } from "./error-detail.js";

const logger = createLogger({ name: "codex-workspace" });

/** Only these task-owned disposable directories may be removed by maintenance. */
export async function codexWorkspace(root: string, prefix: "execution-" | "vision-") {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const cwd = await mkdtemp(join(root, prefix));
  const owner = JSON.stringify({ codec: "codex-workspace/1", pid: process.pid });
  await writeFile(join(cwd, ".crawler-owner.json"), owner, { flag: "wx", mode: 0o600 });
  return cwd;
}

/** Call only after the owned RPC process has a verified exit receipt. */
export async function finishCodexWorkspace(cwd: string) {
  try {
    const stopped = JSON.stringify({
      codec: "codex-workspace-stopped/1",
      at: new Date().toISOString(),
    });
    await writeFile(join(cwd, ".crawler-stopped.json"), stopped, { mode: 0o600 });
    await rm(cwd, { recursive: true, force: true });
  } catch (error) {
    // Cleanup stays best effort; maintenance can see the stop receipt or dead owner.
    logger.warn({ workspace: cwd, detail: describeCodexError(error) }, "Codex cleanup deferred");
  }
}
