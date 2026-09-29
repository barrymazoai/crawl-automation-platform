import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A disposable working directory owned by one call, marked with its owner so maintenance can tell it apart. */
export async function openWorkspace(
  root: string,
  prefix: "execution-" | "vision-",
): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const cwd = await mkdtemp(join(root, prefix));
  const owner = JSON.stringify({ codec: "codex-workspace/1", pid: process.pid });
  await writeFile(join(cwd, ".crawler-owner.json"), owner, { flag: "wx", mode: 0o600 });
  return cwd;
}

/** Writes a file the call reads (an image), created new and readable only by this user. */
export async function writeWorkspaceFile(
  cwd: string,
  entry: { name: string; bytes: Uint8Array },
): Promise<string> {
  const path = join(cwd, entry.name);
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(entry.bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  return path;
}

/** Removes the directory once the call's process has ended; a failure leaves the stop marker for maintenance. */
export async function closeWorkspace(cwd: string): Promise<void> {
  const stopped = JSON.stringify({
    codec: "codex-workspace-stopped/1",
    at: new Date().toISOString(),
  });
  try {
    await writeFile(join(cwd, ".crawler-stopped.json"), stopped, { mode: 0o600 });
    await rm(cwd, { recursive: true, force: true });
  } catch {
    // A later maintenance pass finds the stop marker or the dead owner.
  }
}
