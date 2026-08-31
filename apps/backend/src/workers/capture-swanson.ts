/**
 * Swanson 抓取入口。走 Constructor / Shopify 的 HTTP 接口，**不需要浏览器**，
 * 所以这个进程里既没有 Chrome 也没有代理轮动。
 */
import { DiskGuard } from "../v2/disk-guard.js";
import { runSwansonCaptureCatalog } from "../v2/swanson-capture.js";
import { baseEnv, captureEnv, loadEnv } from "./shared/env.js";
import { startWorker } from "./shared/run.js";
import { diskTelemetry } from "./shared/telemetry.js";

const env = loadEnv(baseEnv, captureEnv);
const disk = new DiskGuard({
  root: env.WORK_ROOT,
  softMinFreeGb: env.DISK_SOFT_MIN_FREE_GB,
  hardMinFreeGb: env.DISK_HARD_MIN_FREE_GB,
  log: (event) => console.log(JSON.stringify(event)),
});

await startWorker({
  role: "capture-swanson",
  capabilities: ["swanson"],
  sourceAdapters: ["swanson"],
  env,
  canClaim: () => disk.allowNewCatalog(),
  telemetry: async () => {
    const diskState = await diskTelemetry(disk, env.DISK_SOFT_MIN_FREE_GB, env.DISK_HARD_MIN_FREE_GB);
    return diskState ? { disk: diskState } : {};
  },
  handle: async ({ job, leaseToken, signal, client }) => {
    const result = await runSwansonCaptureCatalog({
      url: job.source.url,
      runId: job.runId,
      workRoot: env.WORK_ROOT,
      maxItems: env.SWANSON_MAX_ITEMS,
      batchSize: env.V2_CAPTURE_BATCH_SIZE,
      signal,
      registerBatch: (batch) => client.registerCaptureBatch(job.id, leaseToken, batch),
      finalizeCatalog: (catalog) => client.finalizeCatalog(job.id, leaseToken, catalog),
      beforePublish: () => disk.waitForPublishAllowance(signal),
    });
    return result.status === "needs_review"
      ? { review: { reasonCode: result.reasonCode, summary: result.summary } }
      : result;
  },
});
