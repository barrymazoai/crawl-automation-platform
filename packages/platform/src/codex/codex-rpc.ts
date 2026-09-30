import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { codexFailure } from "./errors.js";
import { ProcessExit } from "./process-exit.js";
import { RpcDecoder } from "./rpc-decoder.js";
import { receiveMessage, type PendingRequest, type RpcMessage } from "./rpc-messages.js";

export interface RpcRequestOptions {
  signal: AbortSignal;
  timeoutMs?: number;
}

/** One owned stdio connection. No reconnect, request resend, daemon, or shared active session. */
export class CodexRpc {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exit: ProcessExit;
  private nextId = 0;
  private stopped = false;
  private failure: Error | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();

  constructor(options: {
    executable: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }) {
    this.child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.exit = new ProcessExit(this.child, () => this.fail(codexFailure("TEXT.CODEX_EXITED")));
    this.child.once("error", () => this.fail(codexFailure("TEXT.CODEX_SPAWN")));
    this.child.stdin.on("error", () => this.fail(codexFailure("TEXT.CODEX_TRANSPORT")));
    // Drain stderr without leaking environment/auth-bearing logs into Activity output.
    this.child.stderr.resume();
    const decoder = new RpcDecoder(
      (raw) =>
        receiveMessage(raw, {
          pending: this.pending,
          listeners: this.listeners,
          send: (message) => this.send(message),
          fail: (error) => this.fail(error),
        }),
      (error) => this.fail(error),
    );
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (!this.failure) {
        decoder.read(chunk);
      }
    });
  }

  private assertOpen(): void {
    if (this.failure) {
      throw this.failure;
    }
    if (this.stopped) {
      throw codexFailure("TEXT.CODEX_CLOSED");
    }
  }

  private send(message: object): void {
    this.assertOpen();
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private fail(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.failureListeners) {
      listener(error);
    }
    if (!this.stopped) {
      this.child.kill("SIGTERM");
    }
  }

  onNotification(listener: (message: RpcMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void) {
    this.failureListeners.add(listener);
    if (this.failure) {
      listener(this.failure);
    }
    return () => this.failureListeners.delete(listener);
  }

  async request(method: string, params: unknown, options: AbortSignal | RpcRequestOptions) {
    const { signal, timeoutMs = 30000 } = "signal" in options ? options : { signal: options };
    signal.throwIfAborted();
    this.assertOpen();
    const requestId = ++this.nextId;
    let timer: NodeJS.Timeout | undefined;
    const abort = () => this.fail(codexFailure("TEXT.CODEX_CANCELLED"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        this.pending.set(requestId, { resolve, reject });
        timer = setTimeout(() => this.fail(codexFailure("TEXT.CODEX_TIMEOUT")), timeoutMs);
        try {
          this.send({ id: requestId, method, params });
        } catch (error) {
          this.pending.delete(requestId);
          reject(error);
        }
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  async initialize(signal: AbortSignal) {
    await this.request(
      "initialize",
      {
        clientInfo: { name: "crawler_v3_text", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
      signal,
    );
    this.send({ method: "initialized" });
  }

  /** Terminates only the child created by this connection. */
  async close() {
    if (!this.stopped) {
      this.stopped = true;
      this.fail(codexFailure("TEXT.CODEX_CLOSED"));
      this.child.kill("SIGTERM");
    }
    await this.exit.confirm();
  }
}
