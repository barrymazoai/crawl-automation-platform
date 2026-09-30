/**
 * Amazon 抓取入口。需要真实浏览器（Brand Store 懒加载 + 商品页），
 * 因此这个进程独占一个 Chrome profile——不要和别的抓取入口共用同一个 profile 目录。
 */
import { startChromeLane, type ChromeLane } from "@crawl-automation/runtime";
import { DiskGuard } from "../v2/disk-guard.js";
import { runAmazonCaptureCatalog } from "../v2/amazon-capture.js";
import { baseEnv, browserEnv, captureEnv, loadEnv } from "./shared/env.js";
import { startWorker } from "./shared/run.js";
import { diskTelemetry } from "./shared/telemetry.js";

const env = loadEnv(baseEnv, browserEnv, captureEnv);
const disk = new DiskGuard({
  root: env.WORK_ROOT,
  softMinFreeGb: env.DISK_SOFT_MIN_FREE_GB,
  hardMinFreeGb: env.DISK_HARD_MIN_FREE_GB,
  log: (event) => console.log(JSON.stringify(event)),
});

let chrome: ChromeLane | null = null;
if (!process.env.CHROME_CDP_URL) {
  chrome = await startChromeLane({
    id: 1,
    profileRoot: env.SALES_CHANNEL_CHROME_PROFILE_ROOT,
    ...(env.SALES_CHANNEL_CHROME_EXECUTABLE ? { executablePath: env.SALES_CHANNEL_CHROME_EXECUTABLE } : {}),
    headless: false,
  });
  process.env.CHROME_CDP_URL = chrome.cdpUrl;
}

await startWorker({
  role: "capture-amazon",
  capabilities: ["amazon"],
  sourceAdapters: ["amazon"],
  env,
  canClaim: () => disk.allowNewCatalog(),
  telemetry: async () => {
    const diskState = await diskTelemetry(disk, env.DISK_SOFT_MIN_FREE_GB, env.DISK_HARD_MIN_FREE_GB);
    return diskState ? { disk: diskState } : {};
  },
  handle: async ({ job, leaseToken, signal, client }) => {
    const result = await runAmazonCaptureCatalog({
      url: job.source.url,
      runId: job.runId,
      workRoot: env.WORK_ROOT,
      maxItems: env.AMAZON_MAX_ITEMS,
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
  shutdown: async () => { await chrome?.close(); },
});
