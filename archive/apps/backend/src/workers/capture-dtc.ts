/**
 * DTC 证据转换入口（Mac 侧）。
 *
 * 浏览器抓取仍在 Windows Browser Node 上完成（capture job），这里负责把它产出的
 * 证据包下载、校验、解包，翻译成 CapturedProductBatchV1 并发布 Batch。
 * 转换之后 DTC 与 Sales Channel 走完全相同的处理线。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileSha256 } from "@crawl-automation/runtime";
import { DiskGuard } from "../v2/disk-guard.js";
import { runDtcCaptureCatalog } from "../v2/dtc-capture.js";
import { baseEnv, captureEnv, loadEnv } from "./shared/env.js";
import { startWorker, type JobContext } from "./shared/run.js";
import { diskTelemetry } from "./shared/telemetry.js";

const env = loadEnv(baseEnv, captureEnv);
const disk = new DiskGuard({
  root: env.WORK_ROOT,
  softMinFreeGb: env.DISK_SOFT_MIN_FREE_GB,
  hardMinFreeGb: env.DISK_HARD_MIN_FREE_GB,
  log: (event) => console.log(JSON.stringify(event)),
});

/** 下载上游 capture job 的证据包，逐个校验 sha256。 */
async function downloadEvidence(context: JobContext) {
  const directory = path.join(context.jobDirectory, "input");
  await fs.mkdir(directory, { recursive: true });
  const archives: string[] = [];
  for (const artifact of context.job.inputArtifacts.filter((item: any) => item.kind === "evidence_bundle")) {
    const target = path.join(directory, `${artifact.id}-${artifact.file_name}`);
    if (!await fs.stat(target).catch(() => null)) {
      const { downloadUrl } = await context.client.artifactDownload(artifact.id);
      await context.client.download(downloadUrl, target);
    }
    if (await fileSha256(target) !== artifact.sha256) throw new Error(`产物 ${artifact.id} 的 SHA256 不一致`);
    archives.push(target);
  }
  return archives;
}

await startWorker({
  role: "capture-dtc",
  capabilities: ["dtc"],
  env,
  canClaim: () => disk.allowNewCatalog(),
  telemetry: async () => {
    const diskState = await diskTelemetry(disk, env.DISK_SOFT_MIN_FREE_GB, env.DISK_HARD_MIN_FREE_GB);
    return diskState ? { disk: diskState } : {};
  },
  handle: async (context) => {
    const { job, leaseToken, signal, client } = context;
    const result = await runDtcCaptureCatalog({
      url: job.source.url,
      runId: job.runId,
      workRoot: env.WORK_ROOT,
      batchSize: env.V2_CAPTURE_BATCH_SIZE,
      signal,
      archives: await downloadEvidence(context),
      registerBatch: (batch) => client.registerCaptureBatch(job.id, leaseToken, batch),
      finalizeCatalog: (catalog) => client.finalizeCatalog(job.id, leaseToken, catalog),
      beforePublish: () => disk.waitForPublishAllowance(signal),
    });
    return result.status === "needs_review"
      ? { review: { reasonCode: result.reasonCode, summary: result.summary } }
      : result;
  },
});
