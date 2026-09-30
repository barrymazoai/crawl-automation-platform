import { recordRecovery } from "../logger/recovery.js";
import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { platformErrors } from "../errors/platform-errors.js";

const BEAT_MS = 5_000;

export interface Heartbeat {
  stop(): Promise<void>;
}

/**
 * Writes the process health file the health monitor reads: `{ event, role, pid, reportedAt }`, replaced
 * atomically every 5 seconds. The monitor counts the process ready while `event` is `WORKER_RUNNING`, the PID
 * matches its launchd PID and the file is younger than 15 seconds. Same format as the existing workers.
 */
export async function startHeartbeat(path: string, role: string): Promise<Heartbeat> {
  if (!isAbsolute(path)) {
    throw platformErrors.create("HEALTH.PATH_NOT_ABSOLUTE", { details: { path } });
  }
  const write = async (event: string) => {
    const record = { event, role, pid: process.pid, reportedAt: new Date().toISOString() };
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  };
  await write("WORKER_RUNNING");
  const beat = () =>
    void write("WORKER_RUNNING").catch((error: unknown) => {
      recordRecovery(error, { operation: "health.heartbeat", role });
    });
  const timer = setInterval(beat, BEAT_MS);
  return {
    async stop() {
      clearInterval(timer);
      await write("WORKER_STOPPED");
    },
  };
}
