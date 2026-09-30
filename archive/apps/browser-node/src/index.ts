import fs from "node:fs/promises";
import os from "node:os";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { hostOfUrl, pullSiteProfiles, pushSiteProfiles } from "./site-profile-sync.js";
import {
  CodexAppServerRunner, CodexProcessRunner, LocalCheckpointStore, NodeApiClient, buildBrowserCapturePrompt,
  startChromeLane, withLeaseHeartbeat, zipDirectory,
} from "@crawl-automation/runtime";
import type { CodexRunner } from "@crawl-automation/runtime";
import type { ChromeLane } from "@crawl-automation/runtime";

const env = z.object({
  CONTROL_PLANE_URL: z.url(), NODE_TOKEN: z.string().min(24), NODE_ID: z.string().min(3),
  NODE_NAME: z.string().default("Windows Browser Worker"), NODE_CONCURRENCY: z.coerce.number().int().min(1).max(2).default(2),
  WORK_ROOT: z.string().default(path.resolve(".automation-runs")), LOCAL_STATE_DB: z.string().default(path.resolve(".automation-state/browser.sqlite")),
  // 站点 profile 的本地缓存目录（跨 run 持久）；真正的权威副本在控制面托管的对象存储里，开工前拉、收工后推
  SITE_PROFILE_DIR: z.string().default(path.resolve(".automation-state/site-profiles")),
  REPOSITORY_ROOT: z.string().default(process.cwd()), CODEX_EXECUTABLE: z.string().default("codex"),
  CODEX_RUNNER: z.enum(["exec", "app-server"]).default("exec"), CODEX_SKILL_PATH: z.string().optional(),
  CODEX_MODEL: z.string().default("gpt-5.6-luna"), CODEX_REASONING_EFFORT: z.string().default("medium"),
  CODEX_UNATTENDED_FULL_ACCESS: z.enum(["true", "false"]).default("false"),
  CHROME_EXECUTABLE_PATH: z.string().optional(), CHROME_HEADLESS: z.enum(["true", "false"]).default("false"),
  CHROME_PROFILE_ROOT: z.string().default(path.resolve(".automation-state/chrome")),
  CHROME_STARTUP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
}).parse(process.env);

const resultSchema = z.object({
  status: z.enum(["complete", "needs_review", "failed"]), itemCount: z.number().int().nonnegative(),
  batches: z.array(z.object({ ordinal: z.number().int().nonnegative(), itemCount: z.number().int().nonnegative(), evidenceDirectory: z.string().min(1) })),
  summary: z.string(), reasonCode: z.string().nullable().optional(),
});
const client = new NodeApiClient({ baseUrl: env.CONTROL_PLANE_URL, token: env.NODE_TOKEN, nodeId: env.NODE_ID });
const checkpoints = new LocalCheckpointStore(env.LOCAL_STATE_DB);
const skillPath = path.resolve(env.CODEX_SKILL_PATH ?? path.join(env.REPOSITORY_ROOT, "crawl-products", "SKILL.md"));
const controller = new AbortController();
const active = new Set<string>();
let quotaPaused = false;

type WorkerLane = { id: number; chrome: ChromeLane; runner: CodexRunner };

process.on("SIGINT", () => controller.abort()); process.on("SIGTERM", () => controller.abort());

async function preflightWorkerBrowser(cdpUrl: string) {
  const adapterPath = path.join(env.REPOSITORY_ROOT, "crawl-products", "lib", "worker-cdp-browser.mjs");
  const adapter = await import(pathToFileURL(adapterPath).href) as {
    connectWorkerBrowser(input: { cdpUrl: string }): Promise<any>;
  };
  const browser = await adapter.connectWorkerBrowser({ cdpUrl });
  let tab: any;
  try {
    tab = await browser.tabs.new();
    await tab.goto("data:text/html,<title>crawl-browser-ready</title><main>ready</main>");
    const title = await tab.playwright.evaluate(() => document.title);
    const screenshot = await tab.screenshot();
    if (title !== "crawl-browser-ready" || !screenshot?.length) {
      throw new Error("worker_cdp_preflight_invalid_result");
    }
  } finally {
    await tab?.close().catch(() => {});
    await browser.disconnect().catch(() => {});
  }
}

async function createWorkerLanes() {
  const lanes: WorkerLane[] = [];
  for (let laneId = 1; laneId <= env.NODE_CONCURRENCY; laneId += 1) {
    try {
      lanes.push(await createWorkerLane(laneId));
    } catch (error) {
      console.error(`browser lane ${laneId} unavailable`, error);
    }
  }
  if (lanes.length === 0) throw new Error("no_healthy_browser_lanes");
  return lanes;
}

async function createWorkerLane(laneId: number): Promise<WorkerLane> {
  const chrome = await startChromeLane({
    id: laneId,
    profileRoot: env.CHROME_PROFILE_ROOT,
    ...(env.CHROME_EXECUTABLE_PATH ? { executablePath: env.CHROME_EXECUTABLE_PATH } : {}),
    headless: env.CHROME_HEADLESS === "true",
    startupTimeoutMs: env.CHROME_STARTUP_TIMEOUT_MS,
    preflight: preflightWorkerBrowser,
  });
  const runnerOptions = {
    executable: env.CODEX_EXECUTABLE,
    model: env.CODEX_MODEL,
    reasoningEffort: env.CODEX_REASONING_EFFORT,
    unattendedFullAccess: env.CODEX_UNATTENDED_FULL_ACCESS === "true",
    env: {
      CRAWL_BROWSER_PROVIDER: "worker_cdp",
      CRAWL_BROWSER_CDP_URL: chrome.cdpUrl,
      CRAWL_BROWSER_LANE_ID: String(laneId),
      CRAWL_SITE_PROFILE_DIR: env.SITE_PROFILE_DIR,
    },
  };
  const runner: CodexRunner = env.CODEX_RUNNER === "app-server"
    ? new CodexAppServerRunner(runnerOptions)
    : new CodexProcessRunner(runnerOptions);
  console.log(`browser lane ${laneId} ready at ${chrome.cdpUrl}`);
  return { id: laneId, chrome, runner };
}

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

async function handle(claim: any, lane: WorkerLane) {
  const { job, lease } = claim; active.add(job.id);
  try {
    const jobDirectory = path.resolve(env.WORK_ROOT, job.runId, job.id);
    await fs.mkdir(jobDirectory, { recursive: true });
    checkpoints.save(job.id, "capture", "leased", { url: job.source.url }, lease.token);
    await client.start(job.id, lease.token);
    await withLeaseHeartbeat({ client, jobId: job.id, leaseToken: lease.token, signal: controller.signal }, async (signal) => {
      // 站点 profile：先把控制面上这个 host 的探索路线拉到本地，Skill 命中就走复跑而不是首轮视觉旅程。
      // 拉取失败不阻塞抓取（退化为首轮），但要记日志。
      const jobStartedAt = new Date();
      const host = hostOfUrl(job.source.url);
      await pullSiteProfiles(client, env.SITE_PROFILE_DIR, host, (event) => console.log(JSON.stringify({ jobId: job.id, ...event })))
        .catch((error) => console.error(JSON.stringify({ type: "site_profile_pull_failed", jobId: job.id, host, message: error instanceof Error ? error.message : String(error) })));
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
      const basePrompt = buildBrowserCapturePrompt({ url: job.source.url, runId: job.runId, jobDirectory, nodeId: env.NODE_ID, laneId: lane.id, cdpUrl: lane.chrome.cdpUrl, profileDir: env.SITE_PROFILE_DIR });
      const prompt = `${basePrompt}\n\n每批完成后执行：node apps/browser-node/scripts/publish-capture-batch.mjs <任务目录> <ordinal> <item-count> <staging-directory>，把 staging 批次原子发布到 handoff。最终 batches 必须与已发布 handoff 完全一致。`;
      const previousSession = env.CODEX_RUNNER === "app-server" ? checkpoints.getCodexSession(job.id) : null;
      const raw = await lane.runner.run({ prompt, cwd: env.REPOSITORY_ROOT, addDirectories: [jobDirectory], schemaPath: fileURLToPath(new URL("../capture-result.schema.json", import.meta.url)),
        outputPath: path.join(jobDirectory, "capture-result.json"), eventLogPath: path.join(jobDirectory, "codex-events.jsonl"), signal,
        ...(previousSession?.threadId ? { threadId: previousSession.threadId } : {}),
        threadName: `Crawl ${new URL(job.source.url).hostname} · ${job.id.slice(0, 8)}`,
        skill: { name: "crawl-products", path: skillPath },
        onSession: ({ threadId, turnId }) => checkpoints.saveCodexSession(job.id, threadId, turnId, env.CODEX_RUNNER),
      });
      watcherStopped = true; await watcher; if (watcherError) throw watcherError;
      // 无论结果如何，本次学到/更新的 profile 都推回控制面：needs_review 时字段规则往往也已经学到一半，下次能省
      await pushSiteProfiles(client, env.SITE_PROFILE_DIR, jobStartedAt, (event) => console.log(JSON.stringify({ jobId: job.id, ...event })))
        .catch((error) => console.error(JSON.stringify({ type: "site_profile_push_failed", jobId: job.id, host, message: error instanceof Error ? error.message : String(error) })));
      const result = resultSchema.parse(raw);
      if (result.status !== "complete") {
        await client.fail(job.id, lease.token, { code: result.reasonCode ?? `capture_${result.status}`, message: result.summary, retryable: result.status === "failed", needsReview: result.status === "needs_review" });
        return;
      }
      const total = result.batches.reduce((sum, batch) => sum + batch.itemCount, 0);
      if (total !== result.itemCount) throw new Error(`Manifest 数量 ${result.itemCount} 与批次合计 ${total} 不一致`);
      for (const batch of result.batches.sort((a, b) => a.ordinal - b.ordinal)) if (!uploaded.has(batch.ordinal)) uploaded.set(batch.ordinal, await uploadBatch(claim, jobDirectory, batch));
      await client.complete(job.id, lease.token, { itemCount: result.itemCount, artifactIds: [...uploaded.values()], summary: result.summary }, `capture:${job.id}`);
      checkpoints.save(job.id, "capture", "completed", result, lease.token);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/quota|usage limit|rate limit/i.test(message)) quotaPaused = true;
    checkpoints.save(job.id, "capture", "failed", {}, lease.token);
    await client.fail(job.id, lease.token, { code: quotaPaused ? "codex_quota" : "browser_node_error", message, retryable: !quotaPaused, needsReview: quotaPaused }).catch(() => {});
  } finally {
    active.delete(job.id);
    // 无论成败都清掉本站开的页签：Skill 通过 CDP 开的页签不会随 Playwright 断开而关闭，
    // 一站一站累积会拖垮 Chrome（用户 09-04 报告）。失败不抛，只记日志。
    const swept = await lane.chrome.sweepPages().catch(() => ({ closed: 0, kept: 0, failed: -1 }));
    console.log(JSON.stringify({ type: "lane_pages_swept", jobId: job.id, laneId: lane.id, ...swept }));
  }
}

async function runLane(lane: WorkerLane) {
  while (!controller.signal.aborted) {
    try {
      if (!await lane.chrome.health()) {
        console.error(`browser lane ${lane.id} lost Chrome; restarting before the next claim`);
        await lane.runner.close?.();
        await lane.chrome.close();
        Object.assign(lane, await createWorkerLane(lane.id));
        continue;
      }
      const claim = quotaPaused ? null : await client.claim(["browser"]);
      if (claim) await handle(claim, lane);
      else await new Promise((resolve) => setTimeout(resolve, 5_000));
    } catch (error) {
      console.error(`browser lane ${lane.id} error`, error);
    }
  }
}

const lanes = await createWorkerLanes();
// 上报真实代码版本：git 短哈希（拿不到就退回 package 版本）。之前写死 "0.4.0"，节点拉没拉新代码在面板上完全看不出来。
const codeVersion = (() => {
  try { return execSync("git rev-parse --short HEAD", { cwd: env.REPOSITORY_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "unknown"; }
  catch { return "unknown"; }
})();
console.log(JSON.stringify({ type: "browser_node_version", commit: codeVersion, repositoryRoot: env.REPOSITORY_ROOT, siteProfileDir: env.SITE_PROFILE_DIR }));
await client.register({ name: env.NODE_NAME, platform: `${os.platform()} ${os.release()}`, version: codeVersion, capabilities: ["browser"], maxConcurrency: lanes.length });
const heartbeat = setInterval(() => void client.heartbeat([...active]).catch(console.error), 30_000);
try {
  await Promise.all(lanes.map(runLane));
} finally {
  clearInterval(heartbeat);
  await Promise.allSettled(lanes.map(async (lane) => {
    await lane.runner.close?.();
    await lane.chrome.close();
  }));
  checkpoints.close();
}
