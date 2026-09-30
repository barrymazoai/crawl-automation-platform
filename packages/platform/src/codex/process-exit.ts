import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { codexFailure } from "./errors.js";

/** A signal is not an exit receipt: await the owned child's close, even after escalation. */
export class ProcessExit {
  private readonly exited: Promise<void>;
  private observed = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    onExit: () => void,
  ) {
    this.exited = new Promise((resolve) => {
      child.once("close", () => {
        this.observed = true;
        onExit();
        resolve();
      });
    });
  }

  async confirm(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
      clearTimeout(timer);
      if (!this.observed) {
        this.child.kill("SIGKILL");
      }
      await Promise.race([
        this.exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(codexFailure("TEXT.CODEX_STOP_UNCONFIRMED")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
