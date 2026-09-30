import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import fsp from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import archiver from "archiver";
import unzipper from "unzipper";
import type { JobStage, NodeCapability, SalesChannelAdapter } from "@crawl-automation/contracts";

export { CodexAppServerError, CodexAppServerRunner, type CodexAppServerOptions } from "./codex-app-server";
export { hasReadyMarker, listReadyDirectories, publishReadyMarker, readReadyMarker, writeJsonAtomic } from "./ready-marker";
export { allocateLoopbackPort, chromeExecutableCandidates, resolveChromeExecutable, startChromeLane, type ChromeLane } from "./chrome-lane";
export type { CodexRunInput, CodexRunner, CodexSession } from "./codex-runner";

import { ApiError } from "./api-error";
export { ApiError } from "./api-error";

export function sha256(input: string | Buffer) {
  return createHash("sha256").update(input).digest("hex");
}

export function classifyUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw.trim().match(/^https?:\/\//i) ? raw.trim() : `https://${raw.trim()}`); }
  catch { throw new ApiError("invalid_url", `网址无效：${raw}`); }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const isAmazon = host === "amazon.com" || host.endsWith(".amazon.com") || /^amazon\.[a-z.]+$/.test(host) || host.includes("amazon.");
  const isGnc = host === "gnc.com" || host.endsWith(".gnc.com");
  const isSwanson = host === "swansonvitamins.com" || host.endsWith(".swansonvitamins.com");
  const adapter = isAmazon ? "amazon" as const : isGnc ? "gnc" as const : isSwanson ? "swanson" as const : null;
  return {
    url: url.toString(), host,
    type: adapter ? "sales_channel" as const : "dtc_browser" as const,
    adapter,
    supported: true,
    reason: isAmazon ? "Amazon 固定适配器" : isGnc ? "GNC 固定适配器" : isSwanson ? "Swanson 固定适配器" : "DTC 网站由 Browser Node 抓取",
  };
}

export { buildBrowserCapturePrompt } from "./browser-capture-prompt";

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
  constructor(private config: {
    baseUrl: string;
    token: string;
    nodeId: string;
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
    transferTimeoutMs?: number;
    retryAttempts?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
  }) {}
  private isTransient(error: unknown) {
    if (error instanceof ApiError) return [408, 425, 429, 500, 502, 503, 504].includes(error.status);
    if (error instanceof TypeError) return true;
    let current = error;
    while (current && typeof current === "object") {
      const value = current as { name?: string; code?: string; cause?: unknown };
      if (value.name === "AbortError" || value.name === "TimeoutError") return true;
      if (value.code && ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EPIPE"].includes(value.code)) return true;
      current = value.cause;
    }
    return false;
  }
  private async withRetry<T>(enabled: boolean, action: (signal: AbortSignal) => Promise<T>, timeoutMs = this.config.requestTimeoutMs ?? 10_000): Promise<T> {
    const attempts = enabled ? Math.max(1, this.config.retryAttempts ?? 4) : 1;
    const baseDelay = Math.max(0, this.config.retryBaseDelayMs ?? 250);
    const maxDelay = Math.max(baseDelay, this.config.retryMaxDelayMs ?? 2_000);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try { return await action(AbortSignal.timeout(timeoutMs)); }
      catch (error) {
        lastError = error;
        if (attempt === attempts || !this.isTransient(error)) throw error;
        const delayMs = Math.min(maxDelay, baseDelay * (2 ** (attempt - 1)));
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }
  private async request<T>(method: string, requestPath: string, body?: unknown, idempotencyKey?: string, retry = false): Promise<T> {
    const requestBody = body === undefined ? undefined : JSON.stringify(body);
    return this.withRetry(retry, async (signal) => {
      const response = await (this.config.fetchImpl ?? fetch)(`${this.config.baseUrl.replace(/\/$/, "")}${requestPath}`, {
        method,
        signal,
        headers: {
          authorization: `Bearer ${this.config.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        ...(requestBody === undefined ? {} : { body: requestBody }),
      });
      if (response.status === 204) return null as T;
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new ApiError(payload?.error?.code ?? "remote_error", payload?.error?.message ?? `HTTP ${response.status}`, response.status);
      return payload as T;
    });
  }
  register(input: { name: string; platform: string; version: string; capabilities: NodeCapability[]; maxConcurrency: number }) {
    return this.request("POST", "/v1/node/register", { nodeId: this.config.nodeId, ...input }, undefined, true);
  }
  heartbeat(activeJobIds: string[], extras?: Record<string, unknown>) {
    return this.request("POST", "/v1/node/heartbeat", { nodeId: this.config.nodeId, activeJobIds, ...(extras ? { extras } : {}) }, undefined, true);
  }
  claim(capabilities: NodeCapability[], sourceAdapters?: SalesChannelAdapter[]) {
    return this.request<any>("POST", "/v1/node/jobs/claim", {
      nodeId: this.config.nodeId,
      capabilities,
      ...(sourceAdapters ? { sourceAdapters } : {}),
    });
  }
  start(jobId: string, leaseToken: string) { return this.request("POST", `/v1/node/jobs/${jobId}/start`, { leaseToken }, undefined, true); }
  renew(jobId: string, leaseToken: string) { return this.request("POST", `/v1/node/jobs/${jobId}/heartbeat`, { leaseToken }, undefined, true); }
  complete(jobId: string, leaseToken: string, output: unknown, key: string) { return this.request("POST", `/v1/node/jobs/${jobId}/complete`, { leaseToken, output }, key, true); }
  fail(jobId: string, leaseToken: string, failure: { code: string; message: string; retryable: boolean; needsReview?: boolean }) {
    return this.request("POST", `/v1/node/jobs/${jobId}/fail`, { leaseToken, ...failure }, `failure:${jobId}:${sha256(JSON.stringify(failure))}`, true);
  }
  // v2：Batch 原子发布（capture.ready.json 就绪）后注册处理子 DAG。幂等键 = 稳定的 batchId。
  registerCaptureBatch(jobId: string, leaseToken: string, batch: { batchId: string; ordinal: number; itemCount: number; batchDirectory: string; imagesRequired: boolean; exit?: string | null }) {
    return this.request<{ textJobId: string; imagesJobId: string | null; joinJobId: string; unifyJobId: string }>(
      "POST", `/v1/node/jobs/${jobId}/batches`, { leaseToken, ...batch }, undefined, true,
    );
  }
  // v2：目录完全遍历后追加 run 级尾部（catalog_finalize -> ingest_staging -> cleanup_run）。
  finalizeCatalog(jobId: string, leaseToken: string, catalog: { inputKind: "brand_catalog" | "product" | "search"; exhausted: boolean; truncated: boolean; expectedCount: number | null; discoveredCount: number; processedCount: number }) {
    return this.request<{ finalizeJobId: string; ingestJobId: string; cleanupJobId: string; unifyJobCount: number }>(
      "POST", `/v1/node/jobs/${jobId}/finalize-catalog`, { leaseToken, ...catalog }, undefined, true,
    );
  }
  createArtifact(jobId: string, leaseToken: string, metadata: { kind: string; fileName: string; contentType: string; sha256: string; byteSize: number }) {
    return this.request<any>("POST", `/v1/node/jobs/${jobId}/artifacts`, { leaseToken, ...metadata }, `artifact:${jobId}:${metadata.kind}:${metadata.sha256}`, true);
  }
  confirmArtifact(artifactId: string, jobId: string, leaseToken: string) {
    return this.request("POST", `/v1/node/artifacts/${artifactId}/confirm`, { jobId, leaseToken }, undefined, true);
  }
  artifactDownload(artifactId: string) { return this.request<{ downloadUrl: string }>("POST", `/v1/node/artifacts/${artifactId}/download`, {}, undefined, true); }
  runArtifacts(runId: string) { return this.request<{ artifacts: any[] }>("GET", `/v1/node/runs/${runId}/artifacts`, undefined, undefined, true); }
  deleteArtifact(artifactId: string, jobId: string, leaseToken: string) { return this.request("POST", `/v1/node/artifacts/${artifactId}/delete`, { jobId, leaseToken }); }
  /** 站点 profile 同步：任何节点开工前拉、收工后推（控制面按 host 托管在对象存储）。 */
  siteProfiles(host: string) {
    return this.request<{ files: Array<{ fileName: string; sha256: string; byteSize: number; profileVersion: number | null; learnedBy: string | null; updatedAt: string; downloadUrl: string }> }>(
      "GET", `/v1/node/site-profiles/${encodeURIComponent(host)}`, undefined, undefined, true);
  }
  registerSiteProfile(host: string, input: { fileName: string; sha256: string; byteSize: number; profileVersion?: number | null }) {
    return this.request<{ file: { bucketKey: string }; uploadUrl: string }>(
      "POST", `/v1/node/site-profiles/${encodeURIComponent(host)}/files`, { nodeId: this.config.nodeId, ...input }, undefined, true);
  }
  confirmSiteProfile(host: string, fileName: string) {
    return this.request("POST", `/v1/node/site-profiles/${encodeURIComponent(host)}/files/${encodeURIComponent(fileName)}/confirm`, {}, undefined, true);
  }
  async upload(uploadUrl: string, filename: string, hash: string, contentType: string) {
    const data = await fsp.readFile(filename);
    await this.withRetry(true, async (signal) => {
      // 这两个头都在预签名的 SignedHeaders 里（见 object-storage.ts 的 unhoistableHeaders）
      const response = await (this.config.fetchImpl ?? fetch)(uploadUrl, { method: "PUT", signal, headers: { "content-type": contentType, "x-amz-meta-sha256": hash }, body: data });
      if (!response.ok) throw new ApiError("artifact_upload_failed", `上传失败：HTTP ${response.status}`, response.status);
    }, this.config.transferTimeoutMs ?? 120_000);
  }
  async download(downloadUrl: string, filename: string) {
    const data = await this.withRetry(true, async (signal) => {
      const response = await (this.config.fetchImpl ?? fetch)(downloadUrl, { signal });
      if (!response.ok) throw new ApiError("artifact_download_failed", `下载失败：HTTP ${response.status}`, response.status);
      return Buffer.from(await response.arrayBuffer());
    }, this.config.transferTimeoutMs ?? 120_000);
    await fsp.mkdir(path.dirname(filename), { recursive: true });
    await fsp.writeFile(filename, data);
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

export { CodexProcessRunner, codexExecutionPolicyArgs } from "./codex-process";

export async function withLeaseHeartbeat(
  input: { client: NodeApiClient; jobId: string; leaseToken: string; signal?: AbortSignal; intervalMs?: number; maxFailures?: number; onRenewError?: (error: unknown, consecutiveFailures: number) => void },
  action: (signal: AbortSignal) => Promise<unknown>,
) {
  const controller = new AbortController();
  const stop = () => controller.abort(); input.signal?.addEventListener("abort", stop, { once: true });
  // 续期失败不再"一次就放弃"：单次网络抖动不该杀掉一个跑了几分钟的任务。
  // 连续失败到 maxFailures 次才中止，并且每次都把错误抛给调用方记录——
  // 原来这里静默 catch，导致租约过期的真实原因在日志里完全看不到。
  const maxFailures = input.maxFailures ?? 3;
  let consecutiveFailures = 0;
  const renew = async () => {
    try {
      await input.client.renew(input.jobId, input.leaseToken);
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      input.onRenewError?.(error, consecutiveFailures);
      if (consecutiveFailures >= maxFailures) controller.abort();
    }
  };
  const timer = setInterval(() => void renew(), input.intervalMs ?? 30_000);
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
