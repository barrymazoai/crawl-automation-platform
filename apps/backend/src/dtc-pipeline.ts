import fs from "node:fs/promises";
import path from "node:path";
import type { OcrClient } from "@crawl-automation/ocr-client";
import { extractZipSafe } from "@crawl-automation/runtime";
import { z } from "zod";
import { productBatchSchema, type ProductBatch, type SupplySmartDatabase } from "./supply-smart-ingest.js";

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
  return { semanticInputFile, imageCount: images.length };
}

function buildProcessingPrompt(input: { sourceUrl: string; runId: string; semanticInputFile: string; outputFile: string; vocabulary: string[] }) {
  return `你是 Mac mini 上的固定数据处理 Worker。抓取已经结束；不要操作浏览器，不要读取或调用 crawl-products Skill。

任务：${input.runId}
来源网站：${input.sourceUrl}
固定证据索引：${input.semanticInputFile}
必须写入：${input.outputFile}

处理顺序：
1. 先读取固定证据索引。只读取索引中 sourceFiles 明确列出的页面正文/DOM/JSON；不要遍历任务目录。
2. OCR 已经由接口对全部图片并发完成，索引的 images 只提供逻辑 imageId 和 OCR JSON，不提供原图路径。你只读取 OCR 文本，禁止查找、打开或视觉读取原图。仅当 OCR 出现 Facts 面板结构证据时解析配方，禁止把营销图片猜成 Facts。
3. 依据 nutrition_single_products 做语义终判。只保留一个可售的人用口服营养产品；排除 bundle/pack/kit/set、宠物、外用、美妆、器械，以及 ingredients/formula 都没有可靠证据的项。
4. 每个可售变体必须是 products 中独立一条。保留真实 SKU；页面没有 SKU 时 sku=null 且 skuMissing=true，禁止用标题、序号或 URL 猜 SKU。
5. healthFunctions 只能从下方词表选择；mainIngredients 保留可验证名称，能从标签明确读取 substance/form/category 时可用对象，否则用字符串。
6. facts 每条必须用 channel+externalId 对应到产品，只能来自同一变体的 OCR Facts 面板；多张不同配方无法映射时返回 needs_review，不得合并。

把下面格式的纯 JSON 写入 outputFile：
{
  "schemaVersion":"2.0",
  "products":[{
    "domain":"example.com","productName":"...","productUrl":"https://...","channel":"dtc","externalId":"稳定站内 ID","sourceUrl":"https://...","capturedAt":"ISO 时间","crawlScope":"full 或 partial","source":"crawl-automation:${input.runId}","sku":null,"skuMissing":true,"images":[],"healthFunctions":[],"mainIngredients":["..."],"productForm":"capsule","nutritionScope":{"policy":"nutrition_single_products","decision":"included","evidence":["原文证据"]},"variantAttrs":{},"family":null
  }],
  "facts":[{"channel":"dtc","externalId":"...","sourceUrl":"https://...","capturedAt":"ISO 时间","source":"crawl-automation:${input.runId}:label_ocr","confidence":85,"servingSize":1,"servingUnit":"capsule","servingsPerContainer":60,"rows":[{"name":"Vitamin C","amountValue":100,"amountUnit":"mg","dvPercent":111,"position":0,"isActive":true,"parentPosition":null}]}]
}

可选字段无证据时直接省略。products 可以为空，但不能输出不完整产品。写完后重新读取并检查 JSON、数量、externalId 唯一性、SKU 一致性和 facts 引用。

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
  const batch: ProductBatch = productBatchSchema.parse(JSON.parse(await fs.readFile(resolved, "utf8")));
  if (batch.products.length !== result.outputCount) throw new Error("处理结果 outputCount 与 products 数量不一致");
  const listingKeys = batch.products.map((product) => `${product.channel}:${product.externalId}`);
  if (new Set(listingKeys).size !== listingKeys.length) throw new Error("处理结果存在重复 channel+externalId");
  return { result, batch, batchFile: resolved, imageCount: prepared.imageCount };
}
