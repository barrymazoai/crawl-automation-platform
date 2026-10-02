import { setTimeout } from "node:timers/promises";
import { codexFailure } from "./errors.js";

/** Only the fresh detached group of this awaited capture, never the browser application. */
export async function stopCaptureGroup(pid: number | undefined): Promise<void> {
  if (!pid || !Number.isInteger(pid) || pid <= 1) {
    throw codexFailure("TEXT.CODEX_STOP_UNCONFIRMED");
  }
  if (!groupExists(pid)) {
    return;
  }
  signalGroup(pid, "SIGTERM");
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!groupExists(pid)) {
      return;
    }
    if (attempt === 5) {
      signalGroup(pid, "SIGKILL");
    }
    await setTimeout(100);
  }
  throw codexFailure("TEXT.CODEX_STOP_UNCONFIRMED");
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}
