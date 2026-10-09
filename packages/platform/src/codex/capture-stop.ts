import { setTimeout } from "node:timers/promises";
import { execa } from "execa";
import { codexFailure } from "./errors.js";

/** Only the fresh detached group of this awaited capture, never the browser application. */
export async function stopCaptureGroup(pid: number | undefined): Promise<void> {
  if (!pid || !Number.isInteger(pid) || pid <= 1) {
    throw codexFailure("TEXT.CODEX_STOP_UNCONFIRMED");
  }
  if (!(await groupExists(pid))) {
    return;
  }
  signalGroup(pid, "SIGTERM");
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await groupExists(pid))) {
      return;
    }
    if (attempt === 5) {
      signalGroup(pid, "SIGKILL");
    }
    await setTimeout(100);
  }
  throw codexFailure("TEXT.CODEX_STOP_UNCONFIRMED");
}

async function groupExists(pid: number): Promise<boolean> {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    // macOS answers EPERM for a group whose members have all exited but are not yet reaped (zombies), seen on Server
    // 二 2026-10-09 in brand research and DTC captures. The process table decides: only a live member keeps it.
    if (code === "EPERM") {
      return liveMembers(pid);
    }
    throw error;
  }
}

/** Whether any non-zombie process still belongs to the group, read from `ps` (state Z = exited, unreaped). */
export async function liveMembers(pgid: number): Promise<boolean> {
  const { stdout } = await execa("ps", ["-A", "-o", "pgid=,stat="]);
  return stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .some(([group, state]) => Number(group) === pgid && !!state && !state.startsWith("Z"));
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: already gone. EPERM: only unreaped members remain; groupExists decides from the process table.
    if (code !== "ESRCH" && code !== "EPERM") {
      throw error;
    }
  }
}
