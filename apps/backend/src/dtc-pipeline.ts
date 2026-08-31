import fs from "node:fs/promises";
import path from "node:path";
import type { OcrClient } from "@crawl-automation/ocr-client";
import { extractZipSafe } from "@crawl-automation/runtime";
import { z } from "zod";
import { productBatchSchema, type ProductBatch, type SupplySmartDatabase } from "./supply-smart-ingest.js";
import { PRODUCT_UNIFY_PROMPT_RULES } from "./product-unify.js";

const processResultSchema = z.object({
  status: z.enum(["complete", "needs_review", "failed"]),
  recordsFile: z.string().min(1),
  outputCount: z.number().int().nonnegative(),
  summary: z.string().min(1),
  reasonCode: z.string().nullable(),
});

export type ProcessResult = z.infer<typeof processResultSchema>;

export interface DtcPipelineOptions {
  sourceUrl: string;
  runId: string;
  jobDirectory: string;
  archives: string[];
  ocrConcurrency: number;
  ocr: OcrClient;
  supplySmart: SupplySmartDatabase;
  runProcessor: (prompt: string) => Promise<unknown>;
}

async function walkImages(directory: string, output: string[] = []) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkImages(filename, output);
    else if (/\.(png|jpe?g|webp|gif)$/i.test(entry.name)) output.push(filename);
  }
  return output;
}

async function walkFiles(directory: string, output: string[] = []) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkFiles(filename, output);
    else output.push(filename);
  }
  return output;
}

async function mapWithConcurrency<T>(items: readonly T[], concurrency: number, action: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await action(items[index]!, index);
    }
  }));
}

async function prepareEvidence(options: DtcPipelineOptions) {
  const directories: string[] = [];
  for (const [index, archive] of options.archives.entries()) {
    const directory = path.join(options.jobDirectory, "evidence", String(index).padStart(4, "0"));
    if (!await fs.stat(directory).catch(() => null)) await extractZipSafe(archive, directory);
    directories.push(directory);
  }
  const images = (await Promise.all(directories.map((directory) => walkImages(directory)))).flat();
  await mapWithConcurrency(images, options.ocrConcurrency, async (filename) => {
    const cache = `${filename}.ocr.json`;
    if (await fs.stat(cache).catch(() => null)) return;
    const result = await options.ocr.recognize(filename);
    await fs.writeFile(cache, `${JSON.stringify(result, null, 2)}\n`);
  });
  const files = (await Promise.all(directories.map((directory) => walkFiles(directory)))).flat();
  const imageSet = new Set(images);
  const semanticInputFile = path.join(options.jobDirectory, "semantic-input.json");
  const semanticInput = {
    schemaVersion: "1.0",
    sourceUrl: options.sourceUrl,
    runId: options.runId,
    sourceFiles: await Promise.all(files.filter((filename) =>
      !imageSet.has(filename) && !filename.endsWith(".ocr.json") && /\.(?:html?|txt|jsonl?|md|csv|xml)$/i.test(filename),
    ).map(async (filename) => ({
      path: filename,
      byteSize: (await fs.stat(filename)).size,
      mediaType: filename.endsWith(".json") || filename.endsWith(".jsonl") ? "application/json" : filename.endsWith(".html") ? "text/html" : "text/plain",
    }))),
    images: await Promise.all(images.map(async (filename) => ({
      imageId: path.relative(options.jobDirectory, filename),
      ocr: JSON.parse(await fs.readFile(`${filename}.ocr.json`, "utf8")),
    }))),
  };
  await fs.writeFile(semanticInputFile, `${JSON.stringify(semanticInput, null, 2)}\n`);
  return {
    semanticInputFile,
    imageCount: images.length,
    capturedRecordCount: await countCapturedRecordsFromSemanticInput(semanticInputFile),
  };
}

export async function countCapturedRecordsFromSemanticInput(semanticInputFile: string) {
  const semanticInput = JSON.parse(await fs.readFile(semanticInputFile, "utf8")) as {
    sourceFiles?: Array<{ path?: unknown }>;
  };
  let count = 0;
  for (const source of semanticInput.sourceFiles ?? []) {
    if (typeof source.path !== "string" || path.basename(source.path) !== "records.json") continue;
    const records = await fs.readFile(source.path, "utf8")
      .then((raw) => JSON.parse(raw) as unknown)
      .catch(() => null);
    if (Array.isArray(records)) count += records.length;
  }
  return count;
}

function productUrlKey(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/$/, "") || "/";
    return url.toString();
  } catch {
    return null;
  }
}

export function findMissingProductUnifyFields(batch: ProductBatch) {
  return batch.products.flatMap((product) => {
    const missing = [
      !product.titleRaw ? "titleRaw" : null,
      product.variant === undefined ? "variant" : null,
      product.variantConfidence === undefined ? "variantConfidence" : null,
      !product.variantSource ? "variantSource" : null,
      product.attrsRaw === undefined ? "attrsRaw" : null,
    ].filter((value): value is string => Boolean(value));
    return missing.length > 0 ? [`${product.channel}:${product.externalId} 缺少 ${missing.join(",")}`] : [];
  });
}

export function normalizeDtcBatchShapes(rawBatch: unknown) {
  if (!rawBatch || typeof rawBatch !== "object" || !Array.isArray((rawBatch as { products?: unknown }).products)) return rawBatch;
  const normalizeCapturedAt = (value: unknown) => {
    if (typeof value !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return value;
    const timestamp = new Date(value);
    return Number.isNaN(timestamp.getTime()) ? value : timestamp.toISOString();
  };
  return {
    ...(rawBatch as Record<string, unknown>),
    products: (rawBatch as { products: unknown[] }).products.map((product) => {
      if (!product || typeof product !== "object") return product;
      const value = product as Record<string, unknown>;
      const label = typeof value.family === "string" ? value.family.trim() : null;
      return {
        ...value,
        capturedAt: normalizeCapturedAt(value.capturedAt),
        ...(typeof value.family === "string" ? {
          family: label ? { parentExternalId: null, label, evidence: "explicit" } : null,
        } : {}),
      };
    }),
    ...Array.isArray((rawBatch as { facts?: unknown }).facts) ? {
      facts: (rawBatch as { facts: unknown[] }).facts.map((facts) => {
        if (!facts || typeof facts !== "object") return facts;
        const value = facts as Record<string, unknown>;
        return { ...value, capturedAt: normalizeCapturedAt(value.capturedAt) };
      }),
    } : {},
  };
}

export async function hydrateProductImagesFromEvidence(rawBatch: unknown, semanticInputFile: string) {
  if (!rawBatch || typeof rawBatch !== "object" || !Array.isArray((rawBatch as { products?: unknown }).products)) return rawBatch;
  const semanticInput = JSON.parse(await fs.readFile(semanticInputFile, "utf8")) as {
    sourceFiles?: Array<{ path?: unknown }>;
  };
  const imageLookup = new Map<string, string[]>();
  for (const source of semanticInput.sourceFiles ?? []) {
    if (typeof source.path !== "string" || path.basename(source.path) !== "records.json") continue;
    const records = JSON.parse(await fs.readFile(source.path, "utf8")) as unknown;
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      const value = record as { productUrl?: unknown; fields?: { images?: unknown } };
      const key = productUrlKey(value.productUrl);
      const images = Array.isArray(value.fields?.images)
        ? value.fields.images.filter((image): image is string => typeof image === "string")
        : [];
      if (key && images.length > 0) imageLookup.set(key, images);
    }
  }
  return {
    ...(rawBatch as Record<string, unknown>),
    products: (rawBatch as { products: unknown[] }).products.map((product) => {
      if (!product || typeof product !== "object") return product;
      const value = product as Record<string, unknown>;
      if (Array.isArray(value.images) && value.images.length > 0) return product;
      const key = productUrlKey(value.productUrl) ?? productUrlKey(value.sourceUrl);
      return { ...value, images: key ? imageLookup.get(key) ?? [] : [] };
    }),
  };
}

export function buildProcessingPrompt(input: { sourceUrl: string; runId: string; semanticInputFile: string; outputFile: string; vocabulary: string[] }) {
  return `你是 Mac mini 上的固定数据处理 Worker。抓取已经结束；不要操作浏览器，不要读取或调用 crawl-products Skill。

任务：${input.runId}
来源网站：${input.sourceUrl}
固定证据索引：${input.semanticInputFile}
必须写入：${input.outputFile}

处理顺序：
1. 先读取固定证据索引。只读取索引中 sourceFiles 明确列出的页面正文/DOM/JSON；不要遍历任务目录。
2. OCR 已经由接口对全部图片并发完成，索引的 images 只提供逻辑 imageId 和 OCR JSON，不提供原图路径。你只读取 OCR 文本，禁止查找、打开或视觉读取原图。仅当 OCR 出现 Facts 面板结构证据时解析配方，禁止把营销图片猜成 Facts。
3. 依据 nutrition_single_products 做语义终判。保留可售的人用口服营养产品。必须区分“同质多包装”和“混合组合装”：
   - 同质多包装是同一个产品、同一种配方和同一种口味，只是以 4 Pack、12 Pack、case、若干瓶/罐/袋等数量出售；它是正常可售变体，必须保留，饮料按箱/多瓶销售尤其不能因 pack/bundle 字样排除。
   - 混合组合装包含两个或以上不同产品、配方、口味或用途，例如 variety pack、starter kit、gift set；这类才排除。无法证明组合内是否同质时返回 needs_review，禁止直接排除。
   - 继续排除宠物、外用、美妆、器械，以及 ingredients/formula 都没有可靠证据的项。
4. 每个 Shopify/页面可售变体必须是 products 中独立一条。同质多包装的 pack 数量写入 variant.pack，并把渠道原始 Pack/Size/Flavor 等字段保留在 attrsRaw；每瓶/罐容量写入 variant.size，不能把包装数量混成单瓶容量。保留真实 SKU；页面没有 SKU 时 sku=null 且 skuMissing=true，禁止用标题、序号或 URL 猜 SKU。
5. 对每个独立变体执行统一 Product Unify。titleRaw 保留页面原始标题；productName 是清理后的完整可售 SKU 名。Shopify options 等渠道结构化字段先原样放 attrsRaw，再映射到 strict variant；只有缺失维度才从标题提取。
6. DTC externalId 必须带站点命名空间，例如 motherspromise.com:shopify_variant:123456，不能只使用全局上可能冲突的数字 ID。facts 命中某张标签图片时，把该图片的原始 URL 写入 facts.sourceImageUrl；无法可靠对应时省略，禁止猜。
7. healthFunctions 只能从下方词表选择；mainIngredients 保留可验证名称，能从标签明确读取 substance/form/category 时可用对象，否则用字符串。
8. facts 每条必须用 channel+externalId 对应到产品，只能来自同一变体的 OCR Facts 面板；同质多包装的 Facts 仍按标签原始的每份/每瓶/每罐记录，禁止乘以 pack 数量。多张不同配方无法映射时返回 needs_review，不得合并。
9. 净重/容量的单位舍入不是配方冲突。身份字段优先采用 Shopify JSON、页面结构化规格和明确的公制值；OCR 营销图片只作补充。公英制同时出现时按 1 oz = 28.3495 g、1 fl oz = 29.5735 mL 校验：若多个英制读数对应同一公制值且只差一位小数的舍入/OCR 误差，选择与公制换算最接近的读数，或仅保留公制值，不得因此返回 needs_review。只有换算后仍不一致、且会改变可售变体身份时才 review。

${PRODUCT_UNIFY_PROMPT_RULES}

把下面格式的纯 JSON 写入 outputFile：
{
  "schemaVersion":"2.0",
  "products":[{
    "domain":"example.com","productName":"统一后的完整 SKU 名","titleRaw":"页面原始标题","productUrl":"https://...","channel":"dtc","externalId":"example.com:shopify_variant:稳定站内 ID","sourceUrl":"https://...","capturedAt":"ISO 时间","crawlScope":"full 或 partial","source":"crawl-automation:${input.runId}","sku":null,"skuMissing":true,"gtin":"可验证的 8/12/13/14 位数字","baseName":"跨渠道一致的产品线名","variant":{"flavor":"Vanilla","size":"60 Count","form":"capsule"},"variantConfidence":95,"variantSource":"channel_attrs 或 ai_extract","attrsRaw":{"Flavor":"Vanilla","Size":"60 Count"},"images":[],"healthFunctions":[],"mainIngredients":["..."],"productForm":"capsule","nutritionScope":{"policy":"nutrition_single_products","decision":"included","evidence":["原文证据"]},"variantAttrs":{},"family":null
  }],
  "facts":[{"channel":"dtc","externalId":"...","sourceUrl":"https://...","sourceImageUrl":"https://.../facts.jpg","capturedAt":"ISO 时间","source":"crawl-automation:${input.runId}:label_ocr","confidence":85,"servingSize":1,"servingUnit":"capsule","servingsPerContainer":60,"rows":[{"name":"Vitamin C","amountValue":100,"amountUnit":"mg","dvPercent":111,"position":0,"isActive":true,"parentPosition":null}]}]
}

可选字段无证据时直接省略。capturedAt 必须是 UTC Z 格式（例如 2026-08-29T05:39:18.000Z），禁止输出 +08:00 等偏移格式。family 只能是 null，或 {"parentExternalId":null,"label":"明确的系列标签","evidence":"explicit"} 对象，禁止输出字符串。只有固定证据中确实没有任何商品候选时 products 才可以为空；只要 records.json 有候选而最终一条都无法纳入，就返回 needs_review，不能以 complete 输出空数组。写完后重新读取并检查 JSON、数量、externalId 唯一性、SKU 一致性和 facts 引用。

最后按结构化响应契约返回 status/recordsFile/outputCount/summary/reasonCode。complete 时 recordsFile 必须指向上面的文件；证据冲突、变体映射不清或不同 Facts 配方冲突时返回 needs_review。

允许的 healthFunctions：
${input.vocabulary.join(" | ")}`;
}

export async function runDtcProcessing(options: DtcPipelineOptions) {
  const prepared = await prepareEvidence(options);
  const outputFile = path.join(options.jobDirectory, "product-batch.json");
  const vocabulary = await options.supplySmart.loadHealthFunctions();
  const prompt = buildProcessingPrompt({ sourceUrl: options.sourceUrl, runId: options.runId, semanticInputFile: prepared.semanticInputFile, outputFile, vocabulary });
  const result = processResultSchema.parse(await options.runProcessor(prompt));
  if (result.status !== "complete") return { result, batch: null, imageCount: prepared.imageCount };

  const resolved = path.resolve(options.jobDirectory, result.recordsFile);
  const root = path.resolve(options.jobDirectory);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("处理输出路径越界");
  const rawBatch = JSON.parse(await fs.readFile(resolved, "utf8"));
  const normalizedBatch = normalizeDtcBatchShapes(rawBatch);
  const hydratedBatch = await hydrateProductImagesFromEvidence(normalizedBatch, prepared.semanticInputFile);
  const batch: ProductBatch = productBatchSchema.parse(hydratedBatch);
  if (prepared.capturedRecordCount > 0 && batch.products.length === 0) {
    return {
      result: {
        status: "needs_review" as const,
        recordsFile: result.recordsFile,
        outputCount: 0,
        summary: `抓取证据包含 ${prepared.capturedRecordCount} 条商品候选，但 DTC 处理输出为 0；请复核是否误排除了同质多包装或其他可售营养品。`,
        reasonCode: "dtc_zero_output_with_candidates",
      },
      batch: null,
      imageCount: prepared.imageCount,
    };
  }
  const unifyProblems = findMissingProductUnifyFields(batch);
  if (unifyProblems.length > 0) {
    return {
      result: {
        status: "needs_review" as const,
        recordsFile: result.recordsFile,
        outputCount: batch.products.length,
        summary: `Product Unify 输出不完整：${unifyProblems.slice(0, 20).join("; ")}`,
        reasonCode: "dtc_product_unify_incomplete",
      },
      batch: null,
      imageCount: prepared.imageCount,
    };
  }
  await fs.writeFile(resolved, `${JSON.stringify(batch, null, 2)}\n`);
  if (batch.products.length !== result.outputCount) throw new Error("处理结果 outputCount 与 products 数量不一致");
  const listingKeys = batch.products.map((product) => `${product.channel}:${product.externalId}`);
  if (new Set(listingKeys).size !== listingKeys.length) throw new Error("处理结果存在重复 channel+externalId");
  return { result, batch, batchFile: resolved, imageCount: prepared.imageCount };
}
