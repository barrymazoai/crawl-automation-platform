import type { CodexRpc } from "./codex-rpc.js";
import { CodexError, codexFailure } from "./errors.js";
import { TurnNotifications } from "./turn-notifications.js";

/** Subscribes before turn/start so early notifications cannot be lost. */
export class TurnExecution {
  readonly notifications: TurnNotifications;
  readonly done: Promise<void>;
  failure: unknown;
  private readonly offNotice: () => void;
  private readonly offFailure: () => void;
  private reject!: (error: unknown) => void;

  constructor(
    private readonly rpc: CodexRpc,
    threadId: string,
  ) {
    let resolve!: () => void;
    this.done = new Promise<void>((accept, reject) => {
      resolve = accept;
      this.reject = reject;
    });
    // The same rejection is awaited after turn/start; mark early rejection handled until then.
    void this.done.catch(() => undefined);
    this.notifications = new TurnNotifications(threadId, resolve);
    this.offFailure = rpc.onFailure((error) => this.fail(error));
    this.offNotice = rpc.onNotification((message) => {
      try {
        this.notifications.receive(message);
      } catch (error) {
        this.fail(error instanceof CodexError ? error : codexFailure("TEXT.CODEX_PROTOCOL"));
      }
    });
  }

  private fail(error: unknown): void {
    this.failure ??= error;
    this.reject(this.failure);
    void this.rpc.close();
  }

  unsubscribe(): void {
    this.offNotice();
    this.offFailure();
  }
}
