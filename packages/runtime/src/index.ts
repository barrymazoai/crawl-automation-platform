import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import unzipper from "unzipper";
import type { JobStage, NodeCapability } from "@crawl-automation/contracts";
import type { CodexRunInput, CodexRunner } from "./codex-runner";

export { CodexAppServerError, CodexAppServerRunner, type CodexAppServerOptions } from "./codex-app-server";
export type { CodexRunInput, CodexRunner, CodexSession } from "./codex-runner";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export function sha256(input: string | Buffer) {
  return createHash("sha256").update(input).digest("hex");
}

export function classifyUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw.trim().match(/^https?:\/\//i) ? raw.trim() : `https://${raw.trim()}`); }
  catch { throw new ApiError("invalid_url", `网址无效：${raw}`); }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const isAmazon = host === "amazon.com" || host.endsWith(".amazon.com") || /^amazon\.[a-z.]+$/.test(host) || host.includes("amazon.");
  return {
    url: url.toString(), host,
    type: isAmazon ? "sales_channel" as const : "dtc_browser" as const,
    adapter: isAmazon ? "amazon" as const : null,
    supported: true,
    reason: isAmazon ? "Amazon 固定适配器" : "DTC 网站由 Browser Node 抓取",
  };
}

export function buildBrowserCapturePrompt(input: { url: string; runId: string; jobDirectory: string; nodeId: string }) {
  return `你是 Browser Node 上的单站点抓取 Worker，只处理当前任务。\n\n任务 ID：${input.runId}\n节点：${input.nodeId}\n网站：${input.url}\n任务目录：${input.jobDirectory}\n\n开始前拉取 crawl-products Skill 的最新代码，然后完整读取并使用该 Skill。使用本机可编程 Chrome 完成目录发现和页面证据抓取。控制器负责并发、租约、重试和上传；不要访问控制面或业务数据库。\n\n每个可售变体必须作为独立候选项，保留真实 SKU；没有 SKU 时写 sku=null、skuMissing=true，禁止编造。保存清洗后的正文、关键 DOM/JSON、原始图片和必要截图，把语义判断、OCR、最终规范化和入库留给 Mac Worker。\n\n每完成 25–50 个变体生成一个不可变 EvidenceBundleV1 批次并立即发布。遇到登录墙、验证码、站点范围歧义或证据冲突时返回 needs_review。目录耗尽并完成 Manifest 对账后才返回 complete。`;
}

export class LocalCheckpointStore {
  private db: DatabaseSync;
  constructor(filename: string) {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      pragma journal_mode=WAL; pragma busy_timeout=5000;
      create table if not exists checkpoint (
        job_id text primary key, stage text not null, state text not null,
        lease_token text, payload_json text not null default '{}', updated_at text not null
      );
      create table if not exists outbox (
        id text primary key, idempotency_key text not null unique, method text not null,
        request_path text not null, body_json text not null, state text not null default 'pending',
        attempts integer not null default 0, next_attempt_at text not null, last_error text,
        created_at text not null, updated_at text not null
      );
      create table if not exists codex_session (
        job_id text primary key, thread_id text not null, turn_id text,
        runner text not null, updated_at text not null
      );
    `);
  }
  save(jobId: string, stage: JobStage, state: string, payload: unknown, leaseToken?: string) {
    const now = new Date().toISOString();
    this.db.prepare(`insert into checkpoint(job_id,stage,state,lease_token,payload_json,updated_at) values(?,?,?,?,?,?)
      on conflict(job_id) do update set stage=excluded.stage,state=excluded.state,lease_token=coalesce(excluded.lease_token,checkpoint.lease_token),payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
      .run(jobId, stage, state, leaseToken ?? null, JSON.stringify(payload ?? {}), now);
  }
  get(jobId: string) {
    const row = this.db.prepare("select * from checkpoint where job_id=?").get(jobId) as Record<string, unknown> | undefined;
    return row ? { ...row, payload: JSON.parse(String(row.payload_json)) } : null;
  }
  saveCodexSession(jobId: string, threadId: string, turnId?: string, runner = "app-server") {
    const now = new Date().toISOString();
    this.db.prepare(`insert into codex_session(job_id,thread_id,turn_id,runner,updated_at) values(?,?,?,?,?)
      on conflict(job_id) do update set thread_id=excluded.thread_id,
      turn_id=case when excluded.thread_id=codex_session.thread_id then coalesce(excluded.turn_id,codex_session.turn_id) else excluded.turn_id end,
      runner=excluded.runner,updated_at=excluded.updated_at`)
      .run(jobId, threadId, turnId ?? null, runner, now);
  }
  getCodexSession(jobId: string) {
    return (this.db.prepare("select job_id as jobId,thread_id as threadId,turn_id as turnId,runner,updated_at as updatedAt from codex_session where job_id=?")
      .get(jobId) as { jobId: string; threadId: string; turnId: string | null; runner: string; updatedAt: string } | undefined) ?? null;
  }
  enqueue(method: string, requestPath: string, body: unknown, idempotencyKey: string) {
    const now = new Date().toISOString();
    this.db.prepare(`insert into outbox(id,idempotency_key,method,request_path,body_json,next_attempt_at,created_at,updated_at)
      values(?,?,?,?,?,?,?,?) on conflict(idempotency_key) do nothing`)
      .run(randomUUID(), idempotencyKey, method, requestPath, JSON.stringify(body), now, now, now);
  }
  close() { this.db.close(); }
}

export class NodeApiClient {
  constructor(private config: { baseUrl: string; token: string; nodeId: string; fetchImpl?: typeof fetch }) {}
  private async request<T>(method: string, requestPath: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const response = await (this.config.fetchImpl ?? fetch)(`${this.config.baseUrl.replace(/\/$/, "")}${requestPath}`, {
      method,
      headers: {
        authorization: `Bearer ${this.config.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 204) return null as T;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(payload?.error?.code ?? "remote_error", payload?.error?.message ?? `HTTP ${response.status}`, response.status);
    return payload as T;
  }
  register(input: { name: string; platform: string; version: string; capabilities: NodeCapability[]; maxConcurrency: number }) {
    return this.request("POST", "/v1/node/register", { nodeId: this.config.nodeId, ...input });
  }
  heartbeat(activeJobIds: string[]) { return this.request("POST", "/v1/node/heartbeat", { nodeId: this.config.nodeId, activeJobIds }); }
  claim(capabilities: NodeCapability[]) { return this.request<any>("POST", "/v1/node/jobs/claim", { nodeId: this.config.nodeId, capabilities }); }
  start(jobId: string, leaseToken: string) { return this.request("POST", `/v1/node/jobs/${jobId}/start`, { leaseToken }); }
  renew(jobId: string, leaseToken: string) { return this.request("POST", `/v1/node/jobs/${jobId}/heartbeat`, { leaseToken }); }
  complete(jobId: string, leaseToken: string, output: unknown, key: string) { return this.request("POST", `/v1/node/jobs/${jobId}/complete`, { leaseToken, output }, key); }
  fail(jobId: string, leaseToken: string, failure: { code: string; message: string; retryable: boolean; needsReview?: boolean }) {
    return this.request("POST", `/v1/node/jobs/${jobId}/fail`, { leaseToken, ...failure }, `failure:${jobId}:${sha256(JSON.stringify(failure))}`);
  }
  createArtifact(jobId: string, leaseToken: string, metadata: { kind: string; fileName: string; contentType: string; sha256: string; byteSize: number }) {
    return this.request<any>("POST", `/v1/node/jobs/${jobId}/artifacts`, { leaseToken, ...metadata }, `artifact:${jobId}:${metadata.kind}:${metadata.sha256}`);
  }
  confirmArtifact(artifactId: string, jobId: string, leaseToken: string) {
    return this.request("POST", `/v1/node/artifacts/${artifactId}/confirm`, { jobId, leaseToken });
  }
  artifactDownload(artifactId: string) { return this.request<{ downloadUrl: string }>("POST", `/v1/node/artifacts/${artifactId}/download`, {}); }
  runArtifacts(runId: string) { return this.request<{ artifacts: any[] }>("GET", `/v1/node/runs/${runId}/artifacts`); }
  deleteArtifact(artifactId: string, jobId: string, leaseToken: string) { return this.request("POST", `/v1/node/artifacts/${artifactId}/delete`, { jobId, leaseToken }); }
  async upload(uploadUrl: string, filename: string, hash: string, contentType: string) {
    const data = await fsp.readFile(filename);
    const response = await (this.config.fetchImpl ?? fetch)(uploadUrl, { method: "PUT", headers: { "content-type": contentType, "x-amz-meta-sha256": hash }, body: data });
    if (!response.ok) throw new ApiError("artifact_upload_failed", `上传失败：HTTP ${response.status}`, response.status);
  }
  async download(downloadUrl: string, filename: string) {
    const response = await (this.config.fetchImpl ?? fetch)(downloadUrl);
    if (!response.ok) throw new ApiError("artifact_download_failed", `下载失败：HTTP ${response.status}`, response.status);
    await fsp.mkdir(path.dirname(filename), { recursive: true });
    await fsp.writeFile(filename, Buffer.from(await response.arrayBuffer()));
  }
}

export async function fileSha256(filename: string) {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(filename), hash as any);
  return hash.digest("hex");
}

export async function zipDirectory(sourceDirectory: string, outputFile: string) {
  await fsp.mkdir(path.dirname(outputFile), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputFile); const archive = archiver("zip", { zlib: { level: 6 } });
    output.once("close", resolve); output.once("error", reject); archive.once("error", reject);
    archive.pipe(output); archive.directory(sourceDirectory, false); void archive.finalize();
  });
  const stat = await fsp.stat(outputFile);
  return { filename: outputFile, sha256: await fileSha256(outputFile), byteSize: stat.size };
}

export async function extractZipSafe(filename: string, destination: string) {
  await fsp.mkdir(destination, { recursive: true });
  const root = path.resolve(destination);
  const directory = await unzipper.Open.file(filename);
  for (const entry of directory.files) {
    const target = path.resolve(root, entry.path);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new ApiError("zip_path_escape", "压缩包包含不安全路径");
  }
  await directory.extract({ path: root });
}

export class CodexProcessRunner implements CodexRunner {
  constructor(private options: { executable?: string; model?: string; reasoningEffort?: string; unattendedFullAccess?: boolean } = {}) {}
  async run(input: CodexRunInput) {
    await fsp.mkdir(path.dirname(input.outputPath), { recursive: true });
    const args = ["exec", "-", "--model", this.options.model ?? "gpt-5.6-luna", "-c", `model_reasoning_effort=${JSON.stringify(this.options.reasoningEffort ?? "medium")}`,
      "--cd", input.cwd, "--output-schema", input.schemaPath, "--output-last-message", input.outputPath, "--json", "--color", "never"];
    for (const directory of input.addDirectories ?? []) args.push("--add-dir", directory);
    if (this.options.unattendedFullAccess) args.push("--dangerously-bypass-approvals-and-sandbox");
    else args.push("--approve-for-me", "--sandbox", "workspace-write");
    const log = fs.createWriteStream(input.eventLogPath, { flags: "a" });
    const child = spawn(this.options.executable ?? "codex", args, { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: process.env });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false }); child.stdin.end(input.prompt);
    const abort = () => child.kill("SIGTERM"); input.signal?.addEventListener("abort", abort, { once: true });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); })
      .finally(() => { input.signal?.removeEventListener("abort", abort); log.end(); });
    if (input.signal?.aborted) throw new ApiError("codex_aborted", "Codex 任务被终止");
    if (code !== 0) throw new ApiError("codex_failed", `Codex 退出码 ${code}`);
    try { return JSON.parse(await fsp.readFile(input.outputPath, "utf8")); }
    catch { throw new ApiError("codex_output_invalid", "Codex 未生成合法结构化输出"); }
  }
}

export async function withLeaseHeartbeat(input: { client: NodeApiClient; jobId: string; leaseToken: string; signal?: AbortSignal; intervalMs?: number }, action: (signal: AbortSignal) => Promise<unknown>) {
  const controller = new AbortController();
  const stop = () => controller.abort(); input.signal?.addEventListener("abort", stop, { once: true });
  const timer = setInterval(() => void input.client.renew(input.jobId, input.leaseToken).catch(() => controller.abort()), input.intervalMs ?? 30_000);
  try { return await action(controller.signal); }
  finally { clearInterval(timer); controller.abort(); input.signal?.removeEventListener("abort", stop); }
}

export async function runPool(input: { concurrency: number; claim: () => Promise<any>; handle: (claim: any) => Promise<unknown>; signal?: AbortSignal; idleMs?: number; onError?: (error: unknown) => void }) {
  await Promise.all(Array.from({ length: input.concurrency }, async () => {
    while (!input.signal?.aborted) {
      try {
        const claim = await input.claim();
        if (claim) await input.handle(claim);
        else await new Promise((resolve) => setTimeout(resolve, input.idleMs ?? 5_000));
      } catch (error) { input.onError?.(error); }
    }
  }));
}
