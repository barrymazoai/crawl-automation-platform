import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { CodexRunInput, CodexRunner } from "./codex-runner";

type JsonObject = Record<string, any>;

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  log?: fs.WriteStream;
};

type ActiveRun = {
  threadId: string;
  turnId?: string;
  lastAgentMessage?: string;
  approvalRequired?: string;
  log: fs.WriteStream;
  resolve: (turn: JsonObject) => void;
  reject: (error: Error) => void;
};

export class CodexAppServerError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "CodexAppServerError";
  }
}

export type CodexAppServerOptions = {
  executable?: string;
  model?: string;
  reasoningEffort?: string;
  unattendedFullAccess?: boolean;
  requestTimeoutMs?: number;
  processFactory?: () => ChildProcessWithoutNullStreams;
};

function parseStructuredMessage(text: string) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); }
  catch {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    throw new CodexAppServerError("codex_output_invalid", "Codex App Server 未返回合法结构化 JSON");
  }
}

function messageThreadId(message: JsonObject) {
  return message?.params?.threadId ?? message?.params?.thread?.id ?? null;
}

export class CodexAppServerRunner implements CodexRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private requestId = 0;
  private pending = new Map<number, PendingRequest>();
  private active = new Map<string, ActiveRun>();
  private recentStderr: string[] = [];
  private closed = false;

  constructor(private options: CodexAppServerOptions = {}) {}

  private writeLog(log: fs.WriteStream | undefined, direction: "client" | "server" | "stderr", message: unknown) {
    if (!log || log.destroyed) return;
    const payload = typeof message === "string" ? { message } : { message };
    log.write(`${JSON.stringify({ timestamp: new Date().toISOString(), direction, ...payload })}\n`);
  }

  private async ensureStarted() {
    if (this.closed) throw new CodexAppServerError("app_server_closed", "Codex App Server Runner 已关闭");
    if (!this.starting) this.starting = this.start();
    return this.starting;
  }

  private async start() {
    const child = this.options.processFactory?.() ?? spawn(
      this.options.executable ?? "codex",
      ["app-server", "--stdio"],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: process.env },
    );
    this.child = child;
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      this.recentStderr.push(text.trim());
      this.recentStderr = this.recentStderr.filter(Boolean).slice(-20);
      for (const run of this.active.values()) this.writeLog(run.log, "stderr", text);
    });
    child.once("error", (error) => this.failProcess(error));
    child.once("exit", (code, signal) => {
      if (!this.closed) {
        const detail = this.recentStderr.length ? `；stderr=${this.recentStderr.join(" | ")}` : "";
        this.failProcess(new CodexAppServerError("app_server_exited", `Codex App Server 已退出：code=${code ?? "null"}, signal=${signal ?? "null"}${detail}`));
      }
    });

    await this.requestInternal("initialize", {
      clientInfo: { name: "crawl_automation_browser_node", title: "Crawl Automation Browser Node", version: "0.3.0" },
    });
    this.notify("initialized", {});
  }

  private failProcess(error: Error) {
    this.starting = null;
    this.child = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const run of this.active.values()) run.reject(error);
    this.active.clear();
  }

  private onLine(line: string) {
    let message: JsonObject;
    try { message = JSON.parse(line); }
    catch {
      const error = new CodexAppServerError("app_server_protocol_error", `App Server 输出了无效 JSON：${line.slice(0, 200)}`);
      this.failProcess(error);
      return;
    }

    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      this.writeLog(pending.log, "server", message);
      if (message.error) pending.reject(new CodexAppServerError("app_server_request_failed", `${message.error.message ?? "App Server 请求失败"}`));
      else pending.resolve(message.result);
      return;
    }

    const threadId = messageThreadId(message);
    const run = threadId ? this.active.get(threadId) : undefined;
    this.writeLog(run?.log, "server", message);
    if (!run) return;

    if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
      run.lastAgentMessage = message.params.item.text;
    }
    if (message.method === "turn/started") {
      run.turnId = message.params?.turn?.id;
    }
    if (message.method === "turn/completed") {
      run.resolve(message.params.turn);
    }
  }

  private handleServerRequest(message: JsonObject) {
    const threadId = messageThreadId(message);
    const run = threadId ? this.active.get(threadId) : undefined;
    this.writeLog(run?.log, "server", message);
    if (run) run.approvalRequired = message.method;

    let result: JsonObject;
    switch (message.method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "execCommandApproval":
      case "applyPatchApproval":
        result = { decision: "decline" };
        break;
      case "item/permissions/requestApproval":
        result = { permissions: {}, scope: "turn" };
        break;
      case "item/tool/requestUserInput":
        result = { answers: {} };
        break;
      case "mcpServer/elicitation/request":
        result = { action: "decline", content: null, _meta: null };
        break;
      case "item/tool/call":
        result = { contentItems: [], success: false };
        break;
      default:
        result = {};
    }
    this.respond(message.id, result, run?.log);
  }

  private notify(method: string, params: JsonObject, log?: fs.WriteStream) {
    if (!this.child) throw new CodexAppServerError("app_server_not_running", "Codex App Server 尚未启动");
    const message = { method, params };
    this.writeLog(log, "client", message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private respond(id: number | string, result: JsonObject, log?: fs.WriteStream) {
    if (!this.child) return;
    const message = { id, result };
    this.writeLog(log, "client", message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private requestInternal(method: string, params: JsonObject, log?: fs.WriteStream) {
    if (!this.child) return Promise.reject(new CodexAppServerError("app_server_not_running", "Codex App Server 尚未启动"));
    const id = ++this.requestId;
    const message = { method, id, params };
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError("app_server_request_timeout", `App Server 请求超时：${method}`));
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer, ...(log ? { log } : {}) });
      this.writeLog(log, "client", message);
      this.child!.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  private async request(method: string, params: JsonObject, log?: fs.WriteStream) {
    await this.ensureStarted();
    return this.requestInternal(method, params, log);
  }

  async run(input: CodexRunInput) {
    await fsp.mkdir(path.dirname(input.outputPath), { recursive: true });
    await fsp.mkdir(path.dirname(input.eventLogPath), { recursive: true });
    const log = fs.createWriteStream(input.eventLogPath, { flags: "a" });
    let threadId = input.threadId;

    try {
      const threadOptions = {
        model: this.options.model ?? "gpt-5.6-luna",
        cwd: input.cwd,
        approvalPolicy: this.options.unattendedFullAccess ? "never" : "on-request",
        approvalsReviewer: this.options.unattendedFullAccess ? "user" : "auto_review",
        sandbox: this.options.unattendedFullAccess ? "danger-full-access" : "workspace-write",
      };
      if (threadId) {
        try { await this.request("thread/resume", { threadId, ...threadOptions }, log); }
        catch (error) {
          this.writeLog(log, "stderr", `无法恢复 Thread ${threadId}，将创建新 Thread：${error instanceof Error ? error.message : String(error)}`);
          threadId = undefined;
        }
      }
      if (!threadId) {
        const started = await this.request("thread/start", threadOptions, log);
        threadId = String(started.thread.id);
      }
      input.onSession?.({ threadId });
      if (input.threadName) {
        await this.request("thread/name/set", { threadId, name: input.threadName }, log)
          .catch((error) => this.writeLog(log, "stderr", `设置 Thread 名称失败：${error instanceof Error ? error.message : String(error)}`));
      }

      const completion = new Promise<JsonObject>((resolve, reject) => {
        this.active.set(threadId!, { threadId: threadId!, log, resolve, reject });
      });
      void completion.catch(() => {});
      const run = this.active.get(threadId)!;
      const abort = () => {
        if (run.turnId) void this.request("turn/interrupt", { threadId, turnId: run.turnId }, log).catch(() => {});
      };
      input.signal?.addEventListener("abort", abort, { once: true });

      try {
        const outputSchema = JSON.parse(await fsp.readFile(input.schemaPath, "utf8"));
        if (input.skill) {
          const skillRoot = path.dirname(path.dirname(path.resolve(input.skill.path)));
          await this.request("skills/extraRoots/set", { extraRoots: [skillRoot] }, log);
          await this.request("skills/list", { cwds: [input.cwd], forceReload: true }, log);
        }
        const userInput: JsonObject[] = [
          { type: "text", text: input.prompt, text_elements: [] },
        ];
        if (input.skill) userInput.push({ type: "skill", name: input.skill.name, path: path.resolve(input.skill.path) });
        const started = await this.request("turn/start", {
          threadId,
          input: userInput,
          cwd: input.cwd,
          approvalPolicy: this.options.unattendedFullAccess ? "never" : "on-request",
          approvalsReviewer: this.options.unattendedFullAccess ? "user" : "auto_review",
          sandboxPolicy: this.options.unattendedFullAccess
            ? { type: "dangerFullAccess" }
            : {
                type: "workspaceWrite",
                writableRoots: [...new Set([input.cwd, ...(input.addDirectories ?? [])].map((entry) => path.resolve(entry)))],
                networkAccess: true,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              },
          model: this.options.model ?? "gpt-5.6-luna",
          effort: this.options.reasoningEffort ?? "medium",
          outputSchema,
        }, log);
        run.turnId = String(started.turn.id);
        input.onSession?.({ threadId, turnId: run.turnId });
        if (input.signal?.aborted) abort();

        const turn = await completion;
        if (input.signal?.aborted || turn.status === "interrupted") {
          throw new CodexAppServerError("codex_aborted", "Codex App Server 任务被终止");
        }
        if (turn.status !== "completed") {
          const detail = turn.error?.message ?? turn.error?.additionalDetails ?? `status=${turn.status}`;
          throw new CodexAppServerError("codex_failed", `Codex App Server Turn 失败：${detail}`);
        }
        const completedMessages = (turn.items ?? []).filter((item: JsonObject) => item.type === "agentMessage");
        const finalMessage = run.lastAgentMessage ?? completedMessages.at(-1)?.text;
        if (!finalMessage) {
          const suffix = run.approvalRequired ? `；等待处理 ${run.approvalRequired}` : "";
          throw new CodexAppServerError("codex_output_missing", `Codex App Server 没有生成最终消息${suffix}`);
        }
        const result = parseStructuredMessage(finalMessage);
        await fsp.writeFile(input.outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
        return result;
      } finally {
        input.signal?.removeEventListener("abort", abort);
        this.active.delete(threadId);
      }
    } finally {
      await new Promise<void>((resolve) => log.end(resolve));
    }
  }

  async close() {
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.starting = null;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }
}
