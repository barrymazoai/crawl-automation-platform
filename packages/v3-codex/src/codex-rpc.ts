import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { TextError } from "./errors.js";
type Message = {
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: unknown;
};
/** One owned stdio connection. No reconnect, request resend, daemon, or shared active session. */
export class CodexRpc {
    private readonly child: ChildProcessWithoutNullStreams;
    private nextId = 0;
    private buffer = Buffer.alloc(0);
    private total = 0;
    private stopped = false;
    private failure: Error | null = null;
    private pending = new Map<number, {
        resolve(v: unknown): void;
        reject(e: Error): void;
    }>();
    private listeners = new Set<(message: Message) => void>();
    private failureListeners = new Set<(error: Error) => void>();
    private exited: Promise<void>;
    private exitObserved=false;
    constructor(options: {
        executable: string;
        args: string[];
        cwd: string;
        env: NodeJS.ProcessEnv;
    }) {
        this.child = spawn(options.executable, options.args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        this.exited = new Promise(resolve => { this.child.once("close", () => { this.exitObserved=true; this.fail(new TextError("TEXT.CODEX_EXITED")); resolve(); }); });
        this.child.once("error", () => this.fail(new TextError("TEXT.CODEX_SPAWN")));
        this.child.stdin.on("error", () => this.fail(new TextError("TEXT.CODEX_TRANSPORT")));
        // Drain stderr without leaking environment/auth-bearing logs into Activity output.
        this.child.stderr.on("data", () => { });
        this.child.stdout.on("data", (chunk: Buffer) => {
            if (this.failure)
                return;
            this.total += chunk.length;
            if (this.total > 8 * 1024 * 1024 || this.buffer.length + chunk.length > 2 * 1024 * 1024)
                return this.fail(new TextError("TEXT.CODEX_OUTPUT_LIMIT"));
            this.buffer = Buffer.concat([this.buffer, chunk]);
            let end: number;
            while ((end = this.buffer.indexOf(10)) !== -1) {
                const line = this.buffer.subarray(0, end);
                this.buffer = this.buffer.subarray(end + 1);
                try {
                    this.message(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)));
                }
                catch {
                    this.fail(new TextError("TEXT.CODEX_PROTOCOL"));
                    break;
                }
            }
        });
    }
    private message(raw: unknown) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw Error();
        const message = raw as Message;
        if (message.method && message.id !== undefined) {
            // A server request is never silently approved or converted into another model turn.
            this.send({ id: message.id, error: { code: -32601, message: "Client-side tool/auth requests are not supported" } });
            this.fail(new TextError("TEXT.CODEX_SERVER_REQUEST"));
            return;
        }
        if (message.id !== undefined) {
            if (typeof message.id !== "number")
                throw Error();
            const pending = this.pending.get(message.id);
            if (!pending)
                throw Error();
            if (message.error === undefined && !("result" in message))
                throw Error();
            this.pending.delete(message.id);
            if (message.error !== undefined)
                pending.reject(new TextError("TEXT.CODEX_REQUEST_FAILED"));
            else if ("result" in message)
                pending.resolve(message.result);
            return;
        }
        if (typeof message.method !== "string")
            throw Error();
        for (const listener of this.listeners)
            listener(message);
    }
    private send(message: object) {
        if (this.failure)
            throw this.failure;
        if (this.stopped)
            throw new TextError("TEXT.CODEX_CLOSED");
        this.child.stdin.write(JSON.stringify(message) + "\n");
    }
    private fail(error: Error) {
        if (this.failure)
            return;
        this.failure = error;
        for (const p of this.pending.values())
            p.reject(error);
        this.pending.clear();
        for (const listener of this.failureListeners)
            listener(error);
        if (!this.stopped)
            this.child.kill("SIGTERM");
    }
    onNotification(listener: (message: Message) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    onFailure(listener: (error: Error) => void) { this.failureListeners.add(listener); if (this.failure)
        listener(this.failure); return () => this.failureListeners.delete(listener); }
    async request(method: string, params: unknown, signal: AbortSignal, timeoutMs = 30000): Promise<unknown> {
        signal.throwIfAborted();
        if (this.failure)
            throw this.failure;
        if (this.stopped)
            throw new TextError("TEXT.CODEX_CLOSED");
        const id = ++this.nextId;
        let timer: NodeJS.Timeout | undefined;
        const abort = () => this.fail(new TextError("TEXT.CODEX_CANCELLED"));
        signal.addEventListener("abort", abort, { once: true });
        try {
            return await new Promise((resolve, reject) => {
                this.pending.set(id, { resolve, reject });
                timer = setTimeout(() => this.fail(new TextError("TEXT.CODEX_TIMEOUT")), timeoutMs);
                try {
                    this.send({ id, method, params });
                }
                catch (e) {
                    this.pending.delete(id);
                    reject(e);
                }
            });
        }
        finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
        }
    }
    async initialize(signal: AbortSignal) {
        await this.request("initialize", { clientInfo: { name: "crawler_v3_text", version: "0.1.0" }, capabilities: { experimentalApi: true } }, signal);
        this.send({ method: "initialized" });
    }
    /** Terminates only the child created by this connection; never a daemon or another Worker's process. */
    async close() {
        if (!this.stopped) {
            this.stopped = true;
            this.fail(new TextError("TEXT.CODEX_CLOSED"));
            this.child.kill("SIGTERM");
        }
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
            clearTimeout(timer);
            // Sending a signal is not an exit receipt. Await close even after
            // escalation, and fail closed if process/stdio termination is unknown.
            if(!this.exitObserved)this.child.kill("SIGKILL");
            await Promise.race([this.exited, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new TextError("TEXT.CODEX_STOP_UNCONFIRMED")), 5000);
            })]);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
