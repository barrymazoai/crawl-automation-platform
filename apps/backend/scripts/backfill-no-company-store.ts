/**
 * 把已经跑过 finalize、当时因"品牌映射不到公司"被隔离的产品，从 run 目录里的中间产物
 * 回填进无公司旁库（SQLite）。只读 run 目录，不碰控制面、不碰产品库、不重跑任何阶段。
 *
 * 为什么不直接重跑 finalize：重跑会连带重跑 ingest_staging，把已经入库过的 run 再提交一遍；
 * 而回填只需要 capture 里的产品原文 + join.json（语义/成分表）+ unify.json（名称/变体），
 * 这些都还在 run 目录里（cleanup_run 被复核项挡着，一直没删）。
 *
 * 09-02 误删过一批 run 目录，那些 run 的原文已经没了，回填不到，脚本会单独列出来。
 *
 * 用法（在 mini 上 source .env.worker 后；baseEnv 要求 NODE_ID，运维脚本随便给一个即可）：
 *   NODE_ID=ops-backfill NODE_NAME=ops-backfill npx tsx scripts/backfill-no-company-store.ts            预演（只统计）
 *   NODE_ID=ops-backfill NODE_NAME=ops-backfill npx tsx scripts/backfill-no-company-store.ts --apply    写入旁库
 *   可加 --adapter swanson|gnc|dtc 只做一个渠道
 */
import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { hasReadyMarker, listReadyDirectories } from "@crawl-automation/runtime";
import { NoCompanyStore, type NoCompanyProductEntry } from "../src/v2/no-company-store.js";
import { channelRegistry, hooksFor, buildStageContext } from "../src/workers/shared/channels.js";
import { createProductDeps } from "../src/workers/shared/deps.js";
import { baseEnv, codexEnv, loadEnv, productEnv, stageEnv } from "../src/workers/shared/env.js";
import { batchDirectory, READY, runRoot } from "../src/v2/paths.js";
import type { ChannelFactsResult, ChannelHooks } from "../src/v2/stages.js";

const env = loadEnv(baseEnv, codexEnv, productEnv, stageEnv);

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await fs.readFile(filename, "utf8")) as T;
}

/** 与 runCatalogFinalizeStage 同一套判定：included 且 unify 成功且只差公司 → 旁库。 */
async function collect(hooks: ChannelHooks<any, any, any>, runId: string, sourceUrl: string, deps: ReturnType<typeof createProductDeps>) {
  const ctx = buildStageContext({
    deps, workRoot: env.WORK_ROOT, runId, sourceUrl, signal: new AbortController().signal,
    ocrConcurrency: 1, forcePartialScope: true, runModel: async () => { throw new Error("回填不调模型"); },
  });
  const root = runRoot(env.WORK_ROOT, runId);
  // 整个 run 目录都不在（09-02 误删或已被 cleanup_run 回收）→ 原文没了，明确记为丢失，
  // 不能混进"没有可回填产品"里静默跳过。
  const rootExists = await fs.stat(root).then((stat) => stat.isDirectory()).catch(() => false);
  if (!rootExists) return { entries: [] as NoCompanyProductEntry[], missingCapture: true, finalized: false };
  const unifyRoot = path.join(root, "unify");
  const batches = await listReadyDirectories(unifyRoot, READY.unify).catch(() => [] as string[]);
  const entries: NoCompanyProductEntry[] = [];
  let missingCapture = false;
  for (const batchPath of batches) {
    const batchId = path.basename(batchPath);
    const productsDir = path.join(batchDirectory(env.WORK_ROOT, runId, "capture", batchId), "products");
    let files: string[];
    try { files = (await fs.readdir(productsDir)).filter((name) => name.endsWith(".json")).sort(); }
    catch { missingCapture = true; continue; }
    const products = await Promise.all(files.map((name) => readJson<any>(path.join(productsDir, name))));
    const join = await readJson<{ items: Array<{ key: string; semantic: unknown; facts: ChannelFactsResult | null }> }>(
      path.join(batchDirectory(env.WORK_ROOT, runId, "join", batchId), "join.json"));
    const unify = await readJson<{ results: Array<{ clientRef: string }> }>(path.join(batchPath, "unify.json"));
    const joinByKey = new Map(join.items.map((item) => [item.key, item]));
    const unifyByKey = new Map(unify.results.map((item) => [item.clientRef, item]));
    for (const product of products) {
      const key = hooks.key(product);
      const item = joinByKey.get(key);
      const semantic = item?.semantic;
      if (!semantic || !hooks.included(semantic)) continue;
      if (item?.facts?.review) continue;
      if (hooks.validate && hooks.validate(product, semantic, item?.facts ?? null).length > 0) continue;
      const unified = unifyByKey.get(key);
      if (!unified) continue;
      const domain = await hooks.resolveDomain(ctx, product);
      if (domain) continue;
      const described = hooks.describe(product);
      const fields = hooks.sidelineFields?.(product) ?? {};
      const ingredients = (semantic as { ingredients?: unknown }).ingredients;
      entries.push({
        channel: hooks.channel, externalId: key, brand: hooks.brand?.(product) ?? null,
        runId, sourceUrl, title: described.title, productUrl: described.productUrl,
        capturedAt: fields.capturedAt ?? null, sku: fields.sku ?? null, price: fields.price ?? null,
        ingredients: Array.isArray(ingredients) ? ingredients.map(String) : [],
        factsRows: item?.facts?.facts?.rows?.length ?? 0,
        raw: product, semantic, unified: unified as any, facts: item?.facts ?? null,
      });
    }
  }
  return { entries, missingCapture, finalized: await hasReadyMarker(path.join(root, "finalize"), READY.finalize) };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const adapterArg = process.argv.indexOf("--adapter");
  const onlyAdapter = adapterArg >= 0 ? process.argv[adapterArg + 1] : null;

  const url = new URL(process.env.PRODUCT_DATABASE_URL!);
  url.pathname = "/crawl_control_plane_v2";
  url.search = "";
  const plane = new pg.Pool({ connectionString: url.toString(), max: 2 });
  // 目标：finalize 已完成、且隔离过产品的 run（不管 run 现在是什么状态，包括 abandoned——
  // 只要目录还在，原文就能回填）
  const runs = await plane.query<{ id: string; adapter: string; url: string; status: string }>(
    `select r.id, s.adapter, s.url, r.status
     from pipeline_run r join pipeline_source s on s.id = r.source_id
     where exists (select 1 from pipeline_job j where j.run_id = r.id and j.stage = 'catalog_finalize' and j.state = 'completed')
       and s.adapter in ('gnc','swanson','dtc')
       ${onlyAdapter ? "and s.adapter = $1" : ""}
     order by r.created_at`,
    onlyAdapter ? [onlyAdapter] : [],
  );
  await plane.end();

  const deps = createProductDeps(env);
  const registry = channelRegistry({ pdfRenderScript: env.GNC_PDF_RENDER_SCRIPT });
  const store = apply ? new NoCompanyStore(env.NO_COMPANY_DB) : null;

  let total = 0, runsWithEntries = 0, lost = 0, written = 0;
  const byBrand = new Map<string, number>();
  const lostRuns: string[] = [];
  for (const run of runs.rows) {
    const hooks = hooksFor(registry, run.adapter as any);
    const { entries, missingCapture } = await collect(hooks, run.id, run.url, deps);
    if (missingCapture && entries.length === 0) { lost += 1; lostRuns.push(`${run.adapter}  ${decodeURIComponent(run.url).replace("https://www.", "").slice(0, 70)}`); continue; }
    if (entries.length === 0) continue;
    runsWithEntries += 1;
    total += entries.length;
    for (const entry of entries) byBrand.set(`${entry.channel} / ${entry.brand ?? "(无品牌)"}`, (byBrand.get(`${entry.channel} / ${entry.brand ?? "(无品牌)"}`) ?? 0) + 1);
    if (store) written += store.upsertMany(entries);
  }
  await deps.close();

  console.log(`扫描 run ${runs.rowCount} 个：可回填的 run ${runsWithEntries} 个 / 产品 ${total} 个；目录已丢失回填不到的 run ${lost} 个\n`);
  console.log("按渠道 / 品牌（前 25）：");
  for (const [k, n] of [...byBrand.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(5)}  ${k}`);
  if (lostRuns.length) { console.log(`\n目录已丢失（前 15）：`); for (const line of lostRuns.slice(0, 15)) console.log(`  ${line}`); }
  if (store) {
    console.log(`\n已写入旁库 ${written} 条；旁库现共 ${store.count()} 条 → ${env.NO_COMPANY_DB}`);
    store.close();
  } else {
    console.log("\n（预演，加 --apply 写入旁库）");
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exit(1); });
