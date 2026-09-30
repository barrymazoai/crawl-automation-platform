import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";
import type { ProcessDescription, StartOptions } from "pm2";
import { pm2Errors } from "./pm2-errors.js";
import { forbidDaemonLaunch } from "./manual-daemon.js";

type Callback<Result = unknown> = (error: Error | null | undefined, value?: Result) => void;

/** Deliberately excludes daemon launch, persistence, reload and automatic restart operations. */
export interface Pm2Api {
  connect(callback: Callback): void;
  disconnect(): void;
  list(callback: Callback<ProcessDescription[]>): void;
  describe(name: string, callback: Callback<ProcessDescription[]>): void;
  start(options: StartOptions, callback: Callback): void;
  stop(id: number, callback: Callback): void;
  delete(id: number, callback: Callback): void;
}

/** Load lazily: importing adapters or printing a dry run must not initialize PM2's home. */
export async function loadPm2(): Promise<Pm2Api> {
  await requireManualDaemon(process.env.PM2_HOME);
  const module = await import("pm2");
  forbidDaemonLaunch(module.default as Pm2Api & Parameters<typeof forbidDaemonLaunch>[0]);
  return module.default;
}

export async function requireManualDaemon(home: string | undefined): Promise<void> {
  if (!home || !isAbsolute(home)) {
    throw pm2Errors.create("PM2.DAEMON_REQUIRED");
  }
  try {
    const pid = Number((await readFile(join(home, "pm2.pid"), "utf8")).trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw pm2Errors.create("PM2.DAEMON_REQUIRED");
    }
    process.kill(pid, 0);
    await daemonSocket(join(home, "rpc.sock"));
  } catch (error) {
    throw pm2Errors.create("PM2.DAEMON_REQUIRED", { cause: error, details: { home } });
  }
}

function daemonSocket(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(pm2Errors.create("PM2.DAEMON_REQUIRED"));
    });
  });
}

export function pm2Call<Result>(
  operation: string,
  invoke: (callback: Callback<Result>) => void,
): Promise<Result | undefined> {
  return new Promise((resolve, reject) => {
    invoke((error, result) => {
      if (error) {
        reject(
          pm2Errors.create("PM2.OPERATION_FAILED", {
            cause: error,
            details: { operation, reason: error.message },
          }),
        );
      } else {
        resolve(result);
      }
    });
  });
}
