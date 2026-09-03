import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { OcrClient } from "@crawl-automation/ocr-client";
import { hasReadyMarker, listReadyDirectories, publishReadyMarker, readReadyMarker, writeJsonAtomic } from "@crawl-automation/runtime";
import { mapWithConcurrency } from "../amazon/ocr-label-pipeline.js";
import { productBatchSchema, type NormalizedProduct, type ProductBatch, type ProductFacts, type SupplySmartDatabase } from "../supply-smart-ingest.js";
import type { ProductObservationClient } from "../product-observation-client.js";
import { decideSalesChannelScope } from "../sales-channel-scope.js";
import { runProductUnify, type ProductUnifyInput, type ProductUnifyOutcome, type ProductUnifyResult } from "../product-unify.js";
import { batchDirectory, READY, runRoot } from "./paths.js";

/**
 * v2 处理线的通用编排层。所有 channel 共用：目录布局、ready 标记恢复、
 * Join 合并规则、quarantine 单产品隔离、scope 降级、run 级一次入库。
 * channel 差异（语义 prompt、Facts 提取阶梯、normalize）全部通过 ChannelHooks 注入——
 * 新增渠道只实现钩子，不复制编排（计划阶段 2 的"通用框架"要求）。
 */

type ModelCall = (input: { prompt: string; tag: string }) => Promise<string>;

export interface StageContext {
  workRoot: string;
  runId: string;
  sourceUrl: string;
  signal: AbortSignal;
  ocr: OcrClient;
  supplySmart: SupplySmartDatabase;
  productWriter: ProductObservationClient;
  ocrConcurrency: number;
  /** 方案 9：迁移期强制 partial，物理上杜绝缺席下架。验收通过后才允许关闭。 */
  forcePartialScope: boolean;
  runModel: ModelCall;
}

export interface ChannelFactsResult {
  facts: ProductFacts | null;
  review?: string | undefined;
}

export interface NormalizeInput<TRaw, TSemantic> {
  product: TRaw;
  semantic: TSemantic;
  unified: ProductUnifyResult;
  domain: string;
  facts: ChannelFactsResult | null;
  scope: "full" | "partial";
}

export interface ChannelHooks<TRaw = unknown, TSemantic = unknown, TFacts extends ChannelFactsResult = ChannelFactsResult> {
  channel: string;
  /** 产品身份键（sku / externalId / ASIN），贯穿所有阶段的合并。 */
  key(product: TRaw): string;
  describe(product: TRaw): { title: string; productUrl: string };
  /** 文字线：批量语义清洗（模型调用由编排层限并发）。 */
  clean(ctx: StageContext, products: TRaw[], tagPrefix: string): Promise<{ results: TSemantic[]; warnings: string[] }>;
  semanticKey(semantic: TSemantic): string;
  included(semantic: TSemantic): boolean;
  /** true：Facts 可从页面文本机械/文本模型提取（文字线负责）；false：需要图片线的 OCR 阶梯。 */
  htmlFactsReady(product: TRaw): boolean;
  extractFacts(ctx: StageContext, product: TRaw): Promise<TFacts>;
  /**
   * 可选：Join 阶段两线结果齐全后的补救钩子（例如 Amazon 在语义没找到成分、
   * 标签也没形成 Facts 时，用缓存的 OCR 文本跑一次 ingredient 兜底模型调用）。
   * 返回 null 表示不修改。
   */
  augmentFacts?(ctx: StageContext, product: TRaw, semantic: TSemantic | null, facts: ChannelFactsResult | null): Promise<ChannelFactsResult | null>;
  /**
   * 可选：join 处按"证据到齐后"的事实修订语义判定。
   * 语义阶段跑在图片线之前，靠图片才拿得到成分表的渠道（DTC）在那时必然看不到证据，
   * 会把整批判成 ingredients_and_formula_missing；等 join 时成分表已经在手，排除理由不再成立。
   */
  reviseScope?(semantic: TSemantic, facts: ChannelFactsResult | null): TSemantic;
  /** 返回 null 表示该产品无法构造 Unify 输入（会在 finalize 被隔离）。 */
  unifyInput(product: TRaw, semantic: TSemantic): ProductUnifyInput | null;
  /** 可选：对 Unify 结果做渠道规范化（例如 Amazon 的 strength 归一）。 */
  mapUnifyResult?(result: ProductUnifyResult): ProductUnifyResult;
  unifyBatchSize?: number;
  /** 可选：finalize 阶段的渠道级质量校验，返回的原因会把该产品送进隔离区。 */
  validate?(product: TRaw, semantic: TSemantic, facts: ChannelFactsResult | null): string[];
  resolveDomain(ctx: StageContext, product: TRaw): Promise<string | null>;
  normalize(ctx: StageContext, input: NormalizeInput<TRaw, TSemantic>): NormalizedProduct;
}

export const batchStagePayloadSchema = z.object({
  batchId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  itemCount: z.number().int().positive(),
  batchDirectory: z.string().min(1),
}).loose();

export const catalogFinalizePayloadSchema = z.object({
  inputKind: z.enum(["brand_catalog", "product", "search"]),
  exhausted: z.boolean(),
  truncated: z.boolean(),
  expectedCount: z.number().int().nonnegative().nullable(),
  discoveredCount: z.number().int().nonnegative(),
  processedCount: z.number().int().nonnegative(),
}).loose();

type FactsEntry = { key: string; result: ChannelFactsResult };
type TextOutput = { semantic: { results: unknown[]; warnings: string[] }; facts: FactsEntry[] };
type ImagesOutput = { facts: FactsEntry[] };
type JoinItem = { key: string; semantic: unknown | null; facts: ChannelFactsResult | null };
type JoinOutput = { items: JoinItem[]; warnings: string[] };
export type QuarantineEntry = { key: string; title: string; productUrl: string; reasons: string[] };

async function readJsonFile<T>(filename: string): Promise<T> {
  return JSON.parse(await fs.readFile(filename, "utf8")) as T;
}

async function readCaptureProducts<TRaw>(ctx: StageContext, batchId: string): Promise<TRaw[]> {
  const directory = path.join(batchDirectory(ctx.workRoot, ctx.runId, "capture", batchId), "products");
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(files.map((name) => readJsonFile<TRaw>(path.join(directory, name))));
}

/** process_text：语义清洗 + 文字路径 Facts（不依赖任何图片工作，不等待图片线）。 */
export async function runProcessTextStage<TRaw, TSemantic, TFacts extends ChannelFactsResult>(
  hooks: ChannelHooks<TRaw, TSemantic, TFacts>, ctx: StageContext, rawPayload: unknown,
) {
  const payload = batchStagePayloadSchema.parse(rawPayload);
  const directory = batchDirectory(ctx.workRoot, ctx.runId, "text", payload.batchId);
  if (await hasReadyMarker(directory, READY.text)) {
    const cached = await readJsonFile<TextOutput>(path.join(directory, "text.json"));
    return { batchId: payload.batchId, itemCount: cached.semantic.results.length, textFactsCount: cached.facts.length, resumed: true };
  }
  const products = await readCaptureProducts<TRaw>(ctx, payload.batchId);
  const semantic = await hooks.clean(ctx, products, `${hooks.channel}-v2-semantic-${payload.batchId}`);
  const textProducts = products.filter((product) => hooks.htmlFactsReady(product));
  const facts: FactsEntry[] = await mapWithConcurrency(textProducts, 2, async (product) => ({
    key: hooks.key(product),
    result: await hooks.extractFacts(ctx, product),
  }));
  const output: TextOutput = { semantic, facts };
  await writeJsonAtomic(path.join(directory, "text.json"), output);
  await publishReadyMarker(directory, READY.text, { batchId: payload.batchId, itemCount: semantic.results.length });
  return { batchId: payload.batchId, itemCount: semantic.results.length, textFactsCount: facts.length, resumed: false };
}

/** process_images：只处理文字路径覆盖不了的产品，走 PDF/OCR/视觉补救阶梯。 */
export async function runProcessImagesStage<TRaw, TSemantic, TFacts extends ChannelFactsResult>(
  hooks: ChannelHooks<TRaw, TSemantic, TFacts>, ctx: StageContext, rawPayload: unknown,
) {
  const payload = batchStagePayloadSchema.parse(rawPayload);
  const directory = batchDirectory(ctx.workRoot, ctx.runId, "images", payload.batchId);
  if (await hasReadyMarker(directory, READY.images)) {
    const cached = await readJsonFile<ImagesOutput>(path.join(directory, "images.json"));
    return { batchId: payload.batchId, factsCount: cached.facts.length, resumed: true };
  }
  const products = (await readCaptureProducts<TRaw>(ctx, payload.batchId)).filter((product) => !hooks.htmlFactsReady(product));
  // 产品级并行 + 产品内 OCR 串行，总 OCR 并发不超过 OCR_IMAGE_CONCURRENCY。
  const facts: FactsEntry[] = await mapWithConcurrency(products, Math.min(ctx.ocrConcurrency, 4), async (product) => ({
    key: hooks.key(product),
    result: await hooks.extractFacts(ctx, product),
  }));
  const output: ImagesOutput = { facts };
  await writeJsonAtomic(path.join(directory, "images.json"), output);
  await publishReadyMarker(directory, READY.images, { batchId: payload.batchId, factsCount: facts.length });
  return { batchId: payload.batchId, factsCount: facts.length, resumed: false };
}

/** product_join：合并文字线与图片线。图片线不存在（Batch 无图片任务）时不空等。 */
export async function runProductJoinStage<TRaw, TSemantic, TFacts extends ChannelFactsResult>(
  hooks: ChannelHooks<TRaw, TSemantic, TFacts>, ctx: StageContext, rawPayload: unknown,
) {
  const payload = batchStagePayloadSchema.parse(rawPayload);
  const directory = batchDirectory(ctx.workRoot, ctx.runId, "join", payload.batchId);
  if (await hasReadyMarker(directory, READY.join)) {
    const cached = await readJsonFile<JoinOutput>(path.join(directory, "join.json"));
    return { batchId: payload.batchId, itemCount: cached.items.length, resumed: true };
  }
  const products = await readCaptureProducts<TRaw>(ctx, payload.batchId);
  const text = await readJsonFile<TextOutput>(path.join(batchDirectory(ctx.workRoot, ctx.runId, "text", payload.batchId), "text.json"));
  const imagesDirectory = batchDirectory(ctx.workRoot, ctx.runId, "images", payload.batchId);
  const images = await hasReadyMarker(imagesDirectory, READY.images)
    ? await readJsonFile<ImagesOutput>(path.join(imagesDirectory, "images.json"))
    : { facts: [] as FactsEntry[] };
  const semanticByKey = new Map((text.semantic.results as TSemantic[]).map((item) => [hooks.semanticKey(item), item]));
  const factsByKey = new Map([...text.facts, ...images.facts].map((item) => [item.key, item.result]));
  let revised = 0;
  const items: JoinItem[] = await mapWithConcurrency(products, 2, async (product) => {
    const key = hooks.key(product);
    let semantic: TSemantic | null = semanticByKey.get(key) ?? null;
    let facts = factsByKey.get(key) ?? null;
    if (hooks.augmentFacts) facts = await hooks.augmentFacts(ctx, product, semantic, facts) ?? facts;
    if (semantic && hooks.reviseScope) {
      const next = hooks.reviseScope(semantic, facts);
      if (next !== semantic) { semantic = next; revised += 1; }
    }
    return { key, semantic, facts };
  });
  if (revised) console.log(JSON.stringify({ type: "join_scope_revised", batchId: payload.batchId, revised }));
  const output: JoinOutput = { items, warnings: text.semantic.warnings };
  await writeJsonAtomic(path.join(directory, "join.json"), output);
  await publishReadyMarker(directory, READY.join, { batchId: payload.batchId, itemCount: output.items.length });
  return { batchId: payload.batchId, itemCount: output.items.length, resumed: false };
}

/** product_unify：对语义判定 included 的产品统一名称与 Variant，结果写入 run 级暂存。 */
export async function runProductUnifyStage<TRaw, TSemantic, TFacts extends ChannelFactsResult>(
  hooks: ChannelHooks<TRaw, TSemantic, TFacts>, ctx: StageContext, rawPayload: unknown,
) {
  const payload = batchStagePayloadSchema.parse(rawPayload);
  const directory = batchDirectory(ctx.workRoot, ctx.runId, "unify", payload.batchId);
  if (await hasReadyMarker(directory, READY.unify)) {
    const cached = await readJsonFile<ProductUnifyOutcome>(path.join(directory, "unify.json"));
    return { batchId: payload.batchId, unifiedCount: cached.results.length, resumed: true };
  }
  const products = await readCaptureProducts<TRaw>(ctx, payload.batchId);
  const join = await readJsonFile<JoinOutput>(path.join(batchDirectory(ctx.workRoot, ctx.runId, "join", payload.batchId), "join.json"));
  const semanticByKey = new Map(join.items.flatMap((item) => item.semantic ? [[item.key, item.semantic as TSemantic] as const] : []));
  const inputs = products.flatMap((product) => {
    const semantic = semanticByKey.get(hooks.key(product));
    if (!semantic || !hooks.included(semantic)) return [];
    const input = hooks.unifyInput(product, semantic);
    return input ? [input] : [];
  });
  const raw = inputs.length > 0
    ? await runProductUnify({
      inputs,
      runModel: ctx.runModel,
      tagPrefix: `${hooks.channel}-v2-unify-${payload.batchId}`,
      ...(hooks.unifyBatchSize ? { batchSize: hooks.unifyBatchSize } : {}),
    })
    : { results: [], problems: [] } satisfies ProductUnifyOutcome;
  const outcome: ProductUnifyOutcome = hooks.mapUnifyResult
    ? { results: raw.results.map((result) => hooks.mapUnifyResult!(result)), problems: raw.problems }
    : raw;
  await writeJsonAtomic(path.join(directory, "unify.json"), outcome);
  await publishReadyMarker(directory, READY.unify, { batchId: payload.batchId, unifiedCount: outcome.results.length });
  return { batchId: payload.batchId, unifiedCount: outcome.results.length, problems: outcome.problems.length, resumed: false };
}

export interface CatalogFinalizeOutput {
  scope: "full" | "partial";
  reasons: string[];
  includedCount: number;
  excludedCount: number;
  quarantinedCount: number;
  factsCount: number;
  batchCount: number;
}

/**
 * catalog_finalize：合并所有 Batch 结果，单产品隔离（方案 3），决定 run 级 scope。
 * 铁律：有产品被隔离 -> processedCount 扣减 -> 自动降级 partial，被隔离产品绝不会被缺席下架。
 */
export async function runCatalogFinalizeStage<TRaw, TSemantic, TFacts extends ChannelFactsResult>(
  hooks: ChannelHooks<TRaw, TSemantic, TFacts>, ctx: StageContext, rawPayload: unknown,
): Promise<CatalogFinalizeOutput> {
  const payload = catalogFinalizePayloadSchema.parse(rawPayload);
  const finalizeDirectory = path.join(runRoot(ctx.workRoot, ctx.runId), "finalize");
  if (await hasReadyMarker(finalizeDirectory, READY.finalize)) {
    return readJsonFile<CatalogFinalizeOutput>(path.join(finalizeDirectory, "catalog.json"));
  }
  const unifyRoot = path.join(runRoot(ctx.workRoot, ctx.runId), "unify");
  const batchDirectories = await listReadyDirectories(unifyRoot, READY.unify);
  const quarantined: QuarantineEntry[] = [];
  const included: Array<{ product: TRaw; semantic: TSemantic; unified: ProductUnifyResult; domain: string; facts: ChannelFactsResult | null }> = [];
  let excludedCount = 0;
  for (const batchPath of batchDirectories) {
    const batchId = path.basename(batchPath);
    const products = await readCaptureProducts<TRaw>(ctx, batchId);
    const join = await readJsonFile<JoinOutput>(path.join(batchDirectory(ctx.workRoot, ctx.runId, "join", batchId), "join.json"));
    const unify = await readJsonFile<ProductUnifyOutcome>(path.join(batchPath, "unify.json"));
    const joinByKey = new Map(join.items.map((item) => [item.key, item]));
    const unifyByKey = new Map(unify.results.map((item) => [item.clientRef, item]));
    for (const product of products) {
      const key = hooks.key(product);
      const item = joinByKey.get(key);
      const semantic = item?.semantic as TSemantic | null | undefined;
      if (!semantic || !hooks.included(semantic)) { excludedCount += 1; continue; }
      const reasons: string[] = [];
      if (item?.facts?.review) reasons.push(item.facts.review);
      if (hooks.validate) reasons.push(...hooks.validate(product, semantic, item?.facts ?? null));
      const unified = unifyByKey.get(key);
      if (!unified) reasons.push(`${key}: Product Unify 没有形成合法名称与变体结果`);
      const domain = await hooks.resolveDomain(ctx, product);
      if (!domain) reasons.push(`${key}: 品牌无法唯一映射到公司域名`);
      if (reasons.length > 0) {
        quarantined.push({ key, ...hooks.describe(product), reasons });
        continue;
      }
      included.push({ product, semantic, unified: unified!, domain: domain!, facts: item?.facts ?? null });
    }
  }

  const scopeDecision = decideSalesChannelScope({
    inputKind: payload.inputKind,
    exhausted: payload.exhausted,
    truncated: payload.truncated,
    expectedCount: payload.expectedCount,
    discoveredCount: payload.discoveredCount,
    processedCount: Math.max(0, payload.processedCount - quarantined.length),
  });
  const reasons = [...scopeDecision.reasons];
  if (quarantined.length > 0) reasons.push(`quarantined:${quarantined.length}`);
  if (ctx.forcePartialScope) reasons.push("force_partial_scope_enabled");
  const scope: "full" | "partial" = ctx.forcePartialScope ? "partial" : scopeDecision.scope;

  const facts: ProductFacts[] = [];
  const normalized = included.map((entry) => {
    if (entry.facts?.facts) facts.push(entry.facts.facts);
    return hooks.normalize(ctx, { product: entry.product, semantic: entry.semantic, unified: entry.unified, domain: entry.domain, facts: entry.facts, scope });
  });
  const batch: ProductBatch = productBatchSchema.parse({ schemaVersion: "2.0", products: normalized, facts });
  await writeJsonAtomic(path.join(finalizeDirectory, "normalized.json"), batch);
  await writeJsonAtomic(path.join(finalizeDirectory, "quarantine.json"), quarantined);
  const output: CatalogFinalizeOutput = {
    scope, reasons,
    includedCount: normalized.length,
    excludedCount,
    quarantinedCount: quarantined.length,
    factsCount: facts.length,
    batchCount: batchDirectories.length,
  };
  await writeJsonAtomic(path.join(finalizeDirectory, "catalog.json"), output);
  await publishReadyMarker(finalizeDirectory, READY.finalize, output);
  return output;
}

export type IngestStagingResult =
  | { status: "complete"; ingestedCount: number; factsCount: number; quarantinedCount: number; scope: string; readbackHash: string; summary: string }
  | { status: "needs_review"; reasonCode: string; summary: string };

/** ingest_staging：整 run 一次入库。completeCrawlRun 只在这里被触发一次（计划 6.4）。 */
export async function runIngestStagingStage(hooks: Pick<ChannelHooks, "channel">, ctx: StageContext): Promise<IngestStagingResult> {
  const finalizeDirectory = path.join(runRoot(ctx.workRoot, ctx.runId), "finalize");
  const catalog = await readJsonFile<CatalogFinalizeOutput>(path.join(finalizeDirectory, "catalog.json"));
  const batch = productBatchSchema.parse(await readJsonFile(path.join(finalizeDirectory, "normalized.json")));
  if (batch.products.length === 0) {
    return { status: "needs_review", reasonCode: `${hooks.channel}_v2_no_ingestable_products`, summary: `没有可入库产品（隔离 ${catalog.quarantinedCount}，排除 ${catalog.excludedCount}）` };
  }
  const ingested = await ctx.productWriter.ingestAndValidate(batch, { runId: ctx.runId, sourceUrl: ctx.sourceUrl });
  await writeJsonAtomic(path.join(runRoot(ctx.workRoot, ctx.runId), "ingest", "result.json"), ingested);
  if (ingested.problems.length > 0 || ingested.verified !== batch.products.length) {
    return { status: "needs_review", reasonCode: `${hooks.channel}_ingest_review`, summary: ingested.problems.slice(0, 20).join("; ") || "产品库回读数量不一致" };
  }
  return {
    status: "complete",
    ingestedCount: ingested.verified,
    factsCount: batch.facts.length,
    quarantinedCount: catalog.quarantinedCount,
    scope: catalog.scope,
    readbackHash: ingested.readbackHash,
    summary: `${hooks.channel} v2 入库完成：${ingested.verified} 产品，Facts ${batch.facts.length}，scope=${catalog.scope}，隔离 ${catalog.quarantinedCount}`,
  };
}

/**
 * cleanup_run 前置：把隔离产品的证据搬到 reviewRoot 长期保留（计划 §9：needs_review 证据不能自动删除），
 * 之后 run 目录才允许整体清理。
 */
export async function preserveQuarantineEvidence(ctx: StageContext, reviewRoot: string) {
  const finalizeDirectory = path.join(runRoot(ctx.workRoot, ctx.runId), "finalize");
  const quarantined = await readReadyMarker(finalizeDirectory, READY.finalize)
    ? await readJsonFile<QuarantineEntry[]>(path.join(finalizeDirectory, "quarantine.json")).catch(() => [] as QuarantineEntry[])
    : [];
  if (quarantined.length === 0) return { preserved: 0 };
  const target = path.resolve(reviewRoot, ctx.runId);
  await fs.mkdir(target, { recursive: true });
  await fs.copyFile(path.join(finalizeDirectory, "quarantine.json"), path.join(target, "quarantine.json"));
  const captureRoot = path.join(runRoot(ctx.workRoot, ctx.runId), "capture");
  for (const directory of await listReadyDirectories(captureRoot, READY.capture)) {
    for (const entry of quarantined) {
      const source = path.join(directory, "products", `${entry.key}.json`);
      if (await fs.stat(source).catch(() => null)) {
        await fs.copyFile(source, path.join(target, `${entry.key}.json`));
      }
    }
  }
  return { preserved: quarantined.length };
}
