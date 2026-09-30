/**
 * v2 并行流水线队列级端到端冒烟（不需要浏览器/Codex/OCR）。
 *
 * 在一次性 Postgres 数据库上验证：
 *  1. v2 DAG：run 初始只有 capture_catalog；
 *  2. 边抓边发：capture 未完成时处理线即可领取 Batch job（验收标准 1 的队列层）；
 *  3. 依赖判定：join 等 text+images；无图片 Batch 的 join 不等图片线（验收标准 4 / §7.4）；
 *  4. run 级尾部：catalog_finalize 等 capture_catalog + 全部 unify；ingest→cleanup 链；
 *  5. 方案 2：单 job needs_review 不冻结兄弟 job，resolveReview 后可重领；
 *  6. 方案 10：registerCaptureBatch 幂等重放返回原结果，内容不一致报错；
 *  7. summary() 的分线吞吐指标。
 *
 * 用法：SMOKE_DATABASE_URL=postgres://localhost:5432/postgres npx tsx scripts/v2-queue-smoke.ts
 * （给的是管理连接；脚本自建/重建 crawl_v2_smoke 库）
 */
import pg from "pg";
import { migrate } from "../src/migrate.js";
import { PipelineRepository } from "../src/repository.js";

const ADMIN_URL = process.env.SMOKE_DATABASE_URL ?? "postgres://localhost:5432/postgres";
const SMOKE_DB = "crawl_v2_smoke";

let passed = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (!condition) {
    console.error(`✗ ${name}`, detail ?? "");
    process.exit(1);
  }
  passed += 1;
  console.log(`✓ ${name}`);
}

async function main() {
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  await admin.query(`drop database if exists ${SMOKE_DB} with (force)`);
  await admin.query(`create database ${SMOKE_DB}`);
  await admin.end();
  const smokeUrl = new URL(ADMIN_URL);
  smokeUrl.pathname = `/${SMOKE_DB}`;
  await migrate(smokeUrl.toString());

  const pool = new pg.Pool({ connectionString: smokeUrl.toString(), max: 5 });
  const repo = new PipelineRepository(pool, 120, new Set(["gnc", "amazon"]));
  const caps = ["gnc", "amazon", "process_text", "process_images", "product_join", "product_unify", "catalog_finalize", "ingest_staging", "cleanup_run"];
  for (const [nodeId, nodeCaps] of [
    ["smoke-capture-gnc", ["gnc"]],
    ["smoke-capture-amazon", ["amazon"]],
    ["smoke-text", ["process_text"]],
    ["smoke-image", ["process_images"]],
    ["smoke-unify", ["product_join", "product_unify"]],
    ["smoke-finalize", ["catalog_finalize", "ingest_staging", "cleanup_run"]],
  ] as const) {
    await repo.registerNode({ nodeId, name: nodeId, platform: "smoke", version: "0", capabilities: nodeCaps as any, maxConcurrency: 8 }, caps);
  }
  const claim = async (nodeId: string, capabilities: string[]) => repo.claim(nodeId, capabilities as any);

  // ---- 1. v2 DAG 形状 ----
  const { created } = await repo.createRuns({ urls: ["https://www.gnc.com/brands/gnc/"], mode: "one_off", scheduleTimezone: "Asia/Shanghai" });
  check("GNC run 创建成功", created.length === 1, created);
  const runId = created[0]!.id;
  const initial = await repo.getRun(runId);
  check("v2 初始 DAG 只有一个 capture_catalog", initial.jobs.length === 1 && initial.jobs[0].stage === "capture_catalog" && initial.jobs[0].required_capability === "gnc", initial.jobs.map((j: any) => j.stage));

  // ---- 2. 抓取领取 + 边抓边发 ----
  const capture = await claim("smoke-capture-gnc", ["gnc"]);
  check("capture_catalog 可被 GNC 抓取节点领取", capture?.job.stage === "capture_catalog");
  await repo.start(capture.job.id, capture.lease.token);
  const b1 = await repo.registerCaptureBatch(capture.job.id, capture.lease.token, { batchId: "batch-000001", ordinal: 0, itemCount: 25, batchDirectory: `${runId}/v2/capture/batch-000001`, imagesRequired: true });
  check("Batch1 fan-out：text+images+join+unify", Boolean(b1.textJobId && b1.imagesJobId && b1.joinJobId && b1.unifyJobId), b1);

  const textClaim1 = await claim("smoke-text", ["process_text"]);
  check("capture 仍在运行时，文字线已可领取 Batch1（抓取线不等处理线）", textClaim1?.job.id === b1.textJobId);
  const joinBlocked = await claim("smoke-unify", ["product_join"]);
  check("join 在 text/images 完成前不可领取（依赖判定）", joinBlocked === null);

  const b2 = await repo.registerCaptureBatch(capture.job.id, capture.lease.token, { batchId: "batch-000002", ordinal: 1, itemCount: 10, batchDirectory: `${runId}/v2/capture/batch-000002`, imagesRequired: false });
  check("Batch2（全 HTML Facts）不创建图片 job", b2.imagesJobId === null, b2);

  // ---- 3. 方案 10：幂等重放与内容不一致 ----
  const replay = await repo.registerCaptureBatch(capture.job.id, capture.lease.token, { batchId: "batch-000001", ordinal: 0, itemCount: 25, batchDirectory: `${runId}/v2/capture/batch-000001`, imagesRequired: true });
  check("registerCaptureBatch 幂等重放返回原 job id", replay.textJobId === b1.textJobId);
  const conflict = await repo.registerCaptureBatch(capture.job.id, capture.lease.token, { batchId: "batch-000001", ordinal: 0, itemCount: 99, batchDirectory: `${runId}/v2/capture/batch-000001`, imagesRequired: true }).then(() => null, (error) => error);
  check("同 batchId 不同内容触发幂等冲突（暴露而不是吞掉）", conflict instanceof Error && conflict.message.includes("不一致"), conflict?.message);

  // ---- 4. Batch1 处理链 ----
  await repo.complete(textClaim1.job.id, textClaim1.lease.token, { itemCount: 25 }, `process_text:${textClaim1.job.id}`);
  const imageClaim = await claim("smoke-image", ["process_images"]);
  check("图片线领取 Batch1", imageClaim?.job.id === b1.imagesJobId);
  await repo.complete(imageClaim.job.id, imageClaim.lease.token, { factsCount: 5 }, `process_images:${imageClaim.job.id}`);
  const joinClaim1 = await claim("smoke-unify", ["product_join"]);
  check("text+images 完成后 join 可领取", joinClaim1?.job.id === b1.joinJobId);
  await repo.complete(joinClaim1.job.id, joinClaim1.lease.token, {}, `product_join:${joinClaim1.job.id}`);
  const unifyClaim1 = await claim("smoke-unify", ["product_unify"]);
  check("join 完成后 unify 可领取", unifyClaim1?.job.id === b1.unifyJobId);
  await repo.complete(unifyClaim1.job.id, unifyClaim1.lease.token, {}, `product_unify:${unifyClaim1.job.id}`);

  // ---- 5. Batch2：join 不等不存在的图片线 ----
  const textClaim2 = await claim("smoke-text", ["process_text"]);
  await repo.complete(textClaim2!.job.id, textClaim2!.lease.token, { itemCount: 10 }, `process_text:${textClaim2!.job.id}`);
  const joinClaim2 = await claim("smoke-unify", ["product_join"]);
  check("无图片 Batch 的 join 只等 text，不空等图片线", joinClaim2?.job.id === b2.joinJobId);
  await repo.complete(joinClaim2.job.id, joinClaim2.lease.token, {}, `product_join:${joinClaim2.job.id}`);
  const unifyClaim2 = await claim("smoke-unify", ["product_unify"]);
  await repo.complete(unifyClaim2!.job.id, unifyClaim2!.lease.token, {}, `product_unify:${unifyClaim2!.job.id}`);

  // ---- 6. run 级尾部 ----
  const tail = await repo.finalizeCatalog(capture.job.id, capture.lease.token, { inputKind: "brand_catalog", exhausted: true, truncated: false, expectedCount: 35, discoveredCount: 35, processedCount: 35 });
  check("finalizeCatalog 关联全部 unify job", tail.unifyJobCount === 2, tail);
  const finalizeBlocked = await claim("smoke-finalize", ["catalog_finalize"]);
  check("capture_catalog 未完成时 catalog_finalize 不可领取", finalizeBlocked === null);
  await repo.complete(capture.job.id, capture.lease.token, { itemCount: 35, batchCount: 2 }, `capture_catalog:${capture.job.id}`);
  const finalizeClaim = await claim("smoke-finalize", ["catalog_finalize"]);
  check("capture 完成后 catalog_finalize 可领取", finalizeClaim?.job.id === tail.finalizeJobId);
  await repo.complete(finalizeClaim.job.id, finalizeClaim.lease.token, { scope: "partial" }, `catalog_finalize:${finalizeClaim.job.id}`);
  const ingestClaim = await claim("smoke-finalize", ["ingest_staging"]);
  check("ingest_staging 在 finalize 后可领取（completeCrawlRun 只会在这里发生一次）", ingestClaim?.job.id === tail.ingestJobId);
  await repo.complete(ingestClaim.job.id, ingestClaim.lease.token, { ingestedCount: 35 }, `ingest_staging:${ingestClaim.job.id}`);
  const cleanupClaim = await claim("smoke-finalize", ["cleanup_run"]);
  check("cleanup_run 在 ingest 后可领取", cleanupClaim?.job.id === tail.cleanupJobId);
  await repo.complete(cleanupClaim.job.id, cleanupClaim.lease.token, { deletedLocalRun: true }, `cleanup_run:${cleanupClaim.job.id}`);
  const done = await repo.getRun(runId);
  check("cleanup_run 完成后 run 状态为 completed", done.run.status === "completed", done.run.status);

  // ---- 7. 方案 2：Review 不冻结兄弟 job ----
  const amazonRun = await repo.createRuns({ urls: ["https://www.amazon.com/stores/GNC/page/12345678-0000-0000-0000-000000000000"], mode: "one_off", scheduleTimezone: "Asia/Shanghai" });
  check("Amazon run 走 v2（capture_catalog / amazon capability）", amazonRun.created.length === 1, amazonRun.rejected);
  const amazonRunId = amazonRun.created[0]!.id;
  const amazonCapture = await claim("smoke-capture-amazon", ["amazon"]);
  check("Amazon capture_catalog 可领取", amazonCapture?.job.stage === "capture_catalog" && amazonCapture?.job.runId === amazonRunId);
  const ab = await repo.registerCaptureBatch(amazonCapture.job.id, amazonCapture.lease.token, { batchId: "batch-000001", ordinal: 0, itemCount: 20, batchDirectory: `${amazonRunId}/v2/capture/batch-000001`, imagesRequired: true });
  const amazonText = await claim("smoke-text", ["process_text"]);
  check("Amazon Batch 文字线可领取", amazonText?.job.id === ab.textJobId);
  await repo.fail(amazonText.job.id, amazonText.lease.token, { code: "ocr_low_confidence", message: "冒烟：模拟单产品问题", retryable: false, needsReview: true }, `fail:${amazonText.job.id}:1`);
  const amazonRunAfterReview = await repo.getRun(amazonRunId);
  check("单 job needs_review 不改写 run 状态（方案 2）", amazonRunAfterReview.run.status !== "needs_review", amazonRunAfterReview.run.status);
  const amazonImage = await claim("smoke-image", ["process_images"]);
  check("兄弟 job（图片线）在 Review 存在时仍可领取", amazonImage?.job.id === ab.imagesJobId);
  const reviews = await repo.listReviews("open");
  check("Review Queue 有一条待处理", reviews.length === 1 && reviews[0]!.reasonCode === "ocr_low_confidence");
  await repo.resolveReview(reviews[0]!.id, "retry", "冒烟：重试");
  const amazonTextRetry = await claim("smoke-text", ["process_text"]);
  check("resolveReview 后 text job 可重新领取", amazonTextRetry?.job.id === ab.textJobId);

  // ---- 8. 指标 ----
  const summary = await repo.summary();
  const stageNames = summary.stages.map((row: any) => row.stage);
  check("summary 输出分线指标", stageNames.includes("capture_catalog") && stageNames.includes("process_text"), stageNames);
  console.log("\n分线吞吐（近 1h）：");
  for (const row of summary.stages) console.log(`  ${row.stage.padEnd(18)} queued=${row.queued} active=${row.active} review=${row.needsReview} done1h=${row.completed1h} avg=${row.avgSeconds24h ?? "-"}s`);

  await pool.end();
  console.log(`\n全部 ${passed} 项检查通过 ✅（数据库 ${SMOKE_DB} 保留，可人工查看后删除）`);
}

main().catch((error) => { console.error(error); process.exit(1); });
