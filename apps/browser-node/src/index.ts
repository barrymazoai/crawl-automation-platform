import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  CodexProcessRunner, LocalCheckpointStore, NodeApiClient, buildBrowserCapturePrompt,
  runPool, withLeaseHeartbeat, zipDirectory,
} from "@crawl-automation/runtime";

const env = z.object({
  CONTROL_PLANE_URL: z.url(), NODE_TOKEN: z.string().min(24), NODE_ID: z.string().min(3),
  NODE_NAME: z.string().default("Windows Browser Worker"), NODE_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(2),
  WORK_ROOT: z.string().default(path.resolve(".automation-runs")), LOCAL_STATE_DB: z.string().default(path.resolve(".automation-state/browser.sqlite")),
  REPOSITORY_ROOT: z.string().default(process.cwd()), CODEX_EXECUTABLE: z.string().default("codex"),
  CODEX_MODEL: z.string().default("gpt-5.6-luna"), CODEX_REASONING_EFFORT: z.string().default("medium"),
  CODEX_UNATTENDED_FULL_ACCESS: z.enum(["true", "false"]).default("false"),
}).parse(process.env);

const resultSchema = z.object({
  status: z.enum(["complete", "needs_review", "failed"]), itemCount: z.number().int().nonnegative(),
  batches: z.array(z.object({ ordinal: z.number().int().nonnegative(), itemCount: z.number().int().nonnegative(), evidenceDirectory: z.string().min(1) })),
  summary: z.string(), reasonCode: z.string().nullable().optional(),
});
const client = new NodeApiClient({ baseUrl: env.CONTROL_PLANE_URL, token: env.NODE_TOKEN, nodeId: env.NODE_ID });
const checkpoints = new LocalCheckpointStore(env.LOCAL_STATE_DB);
const runner = new CodexProcessRunner({ executable: env.CODEX_EXECUTABLE, model: env.CODEX_MODEL, reasoningEffort: env.CODEX_REASONING_EFFORT, unattendedFullAccess: env.CODEX_UNATTENDED_FULL_ACCESS === "true" });
const controller = new AbortController();
const active = new Set<string>();
let quotaPaused = false;

process.on("SIGINT", () => controller.abort()); process.on("SIGTERM", () => controller.abort());

async function listHandoffs(jobDirectory: string) {
  const root = path.join(jobDirectory, "handoff");
  const files = await fs.readdir(root).catch(() => []);
  return Promise.all(files.filter((name) => name.endsWith(".ready.json")).sort().map(async (name) => {
    const descriptor = JSON.parse(await fs.readFile(path.join(root, name), "utf8"));
    return z.object({ ordinal: z.number().int().nonnegative(), itemCount: z.number().int().nonnegative(), evidenceDirectory: z.string().min(1) }).parse(descriptor);
  }));
}

async function uploadBatch(claim: any, jobDirectory: string, batch: { ordinal: number; itemCount: number; evidenceDirectory: string }) {
  const source = path.resolve(jobDirectory, batch.evidenceDirectory);
  if (!source.startsWith(`${path.resolve(jobDirectory)}${path.sep}`)) throw new Error("批次路径越出任务目录");
  const archive = await zipDirectory(source, path.join(jobDirectory, "archives", `evidence-${String(batch.ordinal).padStart(6, "0")}.zip`));
  const created = await client.createArtifact(claim.job.id, claim.lease.token, {
    kind: "evidence_bundle", fileName: path.basename(archive.filename), contentType: "application/zip", sha256: archive.sha256, byteSize: archive.byteSize,
  });
  await client.upload(created.uploadUrl, archive.filename, archive.sha256, "application/zip");
  await client.confirmArtifact(created.artifact.id, claim.job.id, claim.lease.token);
  checkpoints.save(claim.job.id, "capture", "running", { lastUploadedOrdinal: batch.ordinal, artifactId: created.artifact.id }, claim.lease.token);
  return created.artifact.id as string;
}

async function handle(claim: any) {
  const { job, lease } = claim; active.add(job.id);
  const jobDirectory = path.resolve(env.WORK_ROOT, job.runId, job.id);
  await fs.mkdir(jobDirectory, { recursive: true });
  checkpoints.save(job.id, "capture", "leased", { url: job.source.url }, lease.token);
  await client.start(job.id, lease.token);
  try {
    await withLeaseHeartbeat({ client, jobId: job.id, leaseToken: lease.token, signal: controller.signal }, async (signal) => {
      const uploaded = new Map<number, string>(); let watcherStopped = false; let watcherError: unknown;
      const scan = async () => {
        for (const batch of await listHandoffs(jobDirectory)) {
          if (!uploaded.has(batch.ordinal)) uploaded.set(batch.ordinal, await uploadBatch(claim, jobDirectory, batch));
        }
      };
      const watcher = (async () => {
        while (!watcherStopped && !signal.aborted) {
          try { await scan(); } catch (error) { watcherError = error; return; }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      })();
      const basePrompt = buildBrowserCapturePrompt({ url: job.source.url, runId: job.runId, jobDirectory, nodeId: env.NODE_ID });
      const prompt = `${basePrompt}\n\n每批完成后执行：node apps/browser-node/scripts/publish-capture-batch.mjs <任务目录> <ordinal> <item-count> <staging-directory>，把 staging 批次原子发布到 handoff。最终 batches 必须与已发布 handoff 完全一致。`;
      const raw = await runner.run({ prompt, cwd: env.REPOSITORY_ROOT, addDirectories: [jobDirectory], schemaPath: fileURLToPath(new URL("../capture-result.schema.json", import.meta.url)),
        outputPath: path.join(jobDirectory, "capture-result.json"), eventLogPath: path.join(jobDirectory, "codex-events.jsonl"), signal });
      watcherStopped = true; await watcher; if (watcherError) throw watcherError;
      const result = resultSchema.parse(raw);
      if (result.status !== "complete") {
        await client.fail(job.id, lease.token, { code: result.reasonCode ?? `capture_${result.status}`, message: result.summary, retryable: result.status === "failed", needsReview: result.status === "needs_review" });
        return;
      }
      const total = result.batches.reduce((sum, batch) => sum + batch.itemCount, 0);
      if (total !== result.itemCount) throw new Error(`Manifest 数量 ${result.itemCount} 与批次合计 ${total} 不一致`);
      for (const batch of result.batches.sort((a, b) => a.ordinal - b.ordinal)) if (!uploaded.has(batch.ordinal)) uploaded.set(batch.ordinal, await uploadBatch(claim, jobDirectory, batch));
      await client.complete(job.id, lease.token, { itemCount: result.itemCount, artifactIds: [...uploaded.values()], summary: result.summary }, `capture:${job.id}:${result.itemCount}`);
      checkpoints.save(job.id, "capture", "completed", result, lease.token);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/quota|usage limit|rate limit/i.test(message)) quotaPaused = true;
    checkpoints.save(job.id, "capture", "failed", {}, lease.token);
    await client.fail(job.id, lease.token, { code: quotaPaused ? "codex_quota" : "browser_node_error", message, retryable: !quotaPaused, needsReview: quotaPaused }).catch(() => {});
  } finally { active.delete(job.id); }
}

await client.register({ name: env.NODE_NAME, platform: `${os.platform()} ${os.release()}`, version: "0.2.0", capabilities: ["browser"], maxConcurrency: env.NODE_CONCURRENCY });
const heartbeat = setInterval(() => void client.heartbeat([...active]).catch(console.error), 30_000);
try {
  await runPool({ concurrency: env.NODE_CONCURRENCY, signal: controller.signal, claim: () => quotaPaused ? Promise.resolve(null) : client.claim(["browser"]), handle, onError: console.error });
} finally { clearInterval(heartbeat); checkpoints.close(); }
