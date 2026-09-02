import fs from "node:fs/promises";
import path from "node:path";
import type { CapturedProductV1 } from "@crawl-automation/contracts";
import { extractZipSafe, writeJsonAtomic } from "@crawl-automation/runtime";
import { BatchPublisher } from "./batch-publisher.js";
import { runRoot } from "./paths.js";

/**
 * DTC（独立站）的 v2 抓取转换。
 *
 * 浏览器抓取仍然在 Windows Browser Node 上跑（capture job，不变）；这里是 Mac 侧的
 * capture_catalog job：下载并解包证据，把 crawl-products Skill 产出的 records.json
 * 翻译成 CapturedProductBatchV1。翻译之后 DTC 与 Sales Channel 走完全相同的处理线。
 */

export interface DtcRawProduct {
  externalId: string;
  sku: string | null;
  productUrl: string;
  domain: string;
  title: string;
  description: string | null;
  price: string | null;
  currency: string | null;
  available: boolean | null;
  images: string[];
  /** 证据包里已下载好的本地图片绝对路径——图片线直接 OCR，不再重新下载。 */
  localImages: string[];
  variantOptions: Record<string, string>;
  detailText: string | null;
  capturedAt: string;
}

type EvidenceRecord = {
  productUrl?: unknown;
  fields?: Record<string, unknown>;
  gallery?: Array<{ url?: unknown; localPath?: unknown; index?: unknown }>;
  variants?: Array<{ variantId?: unknown; sku?: unknown; title?: unknown; options?: Record<string, unknown>; price?: unknown; url?: unknown; available?: unknown }>;
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** 站点自身的可注册域名——DTC 的品牌域名就是它的公司域名。 */
export function registrableDomain(url: string) {
  const host = new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  const parts = host.split(".");
  return parts.length > 2 && parts[parts.length - 2]!.length > 3 ? parts.slice(-2).join(".") : host;
}

/** 稳定身份键：优先站内变体 ID，其次 SKU，最后归一化后的商品路径；一律带域名前缀保证跨站唯一。 */
export function dtcExternalId(domain: string, productUrl: string, variantId: string | null, sku: string | null) {
  if (variantId) return `${domain}:shopify_variant:${variantId}`;
  if (sku) return `${domain}:sku:${sku}`;
  const pathname = new URL(productUrl).pathname.replace(/\/$/, "") || "/";
  return `${domain}:url:${pathname}`;
}

function galleryImages(record: EvidenceRecord, evidenceDirectory: string) {
  const remote: string[] = [];
  const local: string[] = [];
  for (const item of record.gallery ?? []) {
    const url = text(item.url);
    if (url) remote.push(url);
    const relative = text(item.localPath);
    // Windows 端写的是反斜杠路径，Mac 侧要归一化。
    if (relative) local.push(path.resolve(evidenceDirectory, relative.replace(/\\/g, "/")));
  }
  const fieldImages = record.fields?.images;
  if (Array.isArray(fieldImages)) for (const value of fieldImages) { const url = text(value); if (url) remote.push(url); }
  return { remote: [...new Set(remote)], local: [...new Set(local)] };
}

/**
 * Windows browser-node 打的包（publish-capture-batch 的 EvidenceBundleV1 描述符）：
 *   bundle.json { items:[{ externalId, productUrl, title, sku, variant, sourceFiles:["data/..json", "data/entry.png"], imageFiles:["images/..webp"] }] }
 *   data/<n>-<variantId>.json { productUrl, fields:{ title, description, ingredients_text, images, sku, price, ... }, variant }
 * 与 Skill harvest 的 evidence/records.json 是两套格式（后者一条 record 带多个 variants）。
 * 这里把前者映射成 EvidenceRecord，后面的 recordToProducts 两种来源共用。
 */
type WindowsBundleItem = {
  externalId?: unknown; productUrl?: unknown; title?: unknown; sku?: unknown;
  variant?: { variantId?: unknown; sku?: unknown; title?: unknown; options?: Record<string, unknown>; price?: unknown; url?: unknown; available?: unknown } | null;
  sourceFiles?: unknown; imageFiles?: unknown;
};

export async function readWindowsBundle(directory: string): Promise<EvidenceRecord[] | null> {
  const raw = await fs.readFile(path.join(directory, "bundle.json"), "utf8").catch(() => null);
  if (!raw) return null;
  const bundle = JSON.parse(raw) as { items?: unknown };
  if (!Array.isArray(bundle.items)) return null;
  const records: EvidenceRecord[] = [];
  for (const item of bundle.items as WindowsBundleItem[]) {
    const sourceFiles = Array.isArray(item.sourceFiles) ? item.sourceFiles.filter((v): v is string => typeof v === "string") : [];
    const dataFile = sourceFiles.find((name) => name.endsWith(".json"));
    const data = dataFile
      ? await fs.readFile(path.join(directory, dataFile.replace(/\\/g, "/")), "utf8").then((t) => JSON.parse(t) as { productUrl?: unknown; fields?: Record<string, unknown>; variant?: WindowsBundleItem["variant"] }).catch(() => null)
      : null;
    const fields: Record<string, unknown> = { ...(data?.fields ?? {}) };
    // 字段名对齐 harvest 格式
    if (fields.ingredients == null && fields.ingredients_text != null) fields.ingredients = fields.ingredients_text;
    if (fields.title == null && item.title != null) fields.title = item.title;
    if (fields.sku == null && item.sku != null) fields.sku = item.sku;
    const imageFiles = Array.isArray(item.imageFiles) ? item.imageFiles.filter((v): v is string => typeof v === "string") : [];
    const remoteImages = Array.isArray(fields.images) ? fields.images.filter((v): v is string => typeof v === "string") : [];
    const gallery = imageFiles.map((localPath, index) => ({ localPath, url: remoteImages[index] ?? null, index }));
    const variant = item.variant ?? data?.variant ?? null;
    records.push({
      productUrl: data?.productUrl ?? item.productUrl,
      fields,
      gallery,
      variants: variant && (text(variant.variantId) || text(variant.sku)) ? [variant] : [],
    });
  }
  return records;
}

/** 一条 record 展开成若干产品：有变体则一变体一个产品，否则单个产品。 */
export function recordToProducts(record: EvidenceRecord, evidenceDirectory: string, capturedAt: string): DtcRawProduct[] {
  const productUrl = text(record.productUrl);
  if (!productUrl) return [];
  const domain = registrableDomain(productUrl);
  const fields = record.fields ?? {};
  const title = text(fields.title);
  if (!title) return [];
  const { remote, local } = galleryImages(record, evidenceDirectory);
  const base = {
    domain,
    description: text(fields.description),
    currency: text(fields.currency) ?? "USD",
    images: remote,
    localImages: local,
    detailText: [text(fields.details), text(fields.ingredients)].filter(Boolean).join("\n") || null,
    capturedAt,
  };
  const variants = (record.variants ?? []).filter((variant) => text(variant.variantId) || text(variant.sku));
  if (variants.length === 0) {
    const sku = text(fields.sku);
    return [{
      ...base,
      externalId: dtcExternalId(domain, productUrl, null, sku),
      sku,
      productUrl,
      title,
      price: text(fields.price),
      available: null,
      variantOptions: {},
    }];
  }
  return variants.map((variant) => {
    const variantId = text(variant.variantId);
    const sku = text(variant.sku);
    const variantUrl = text(variant.url) ?? productUrl;
    const options: Record<string, string> = {};
    for (const [key, value] of Object.entries(variant.options ?? {})) {
      const parsed = text(value);
      if (parsed) options[key] = parsed;
    }
    const variantTitle = text(variant.title);
    return {
      ...base,
      externalId: dtcExternalId(domain, variantUrl, variantId, sku),
      sku,
      productUrl: variantUrl,
      // 兄弟变体必须有不同的名称，否则入库时会被 name+company 兜底合并。
      title: variantTitle && variantTitle.toLowerCase() !== title.toLowerCase() ? `${title} — ${variantTitle}` : title,
      price: text(variant.price) ?? text(fields.price),
      available: typeof variant.available === "boolean" ? variant.available : null,
      variantOptions: options,
    };
  });
}

export function toDtcCapturedProduct(product: DtcRawProduct): CapturedProductV1 {
  return {
    externalId: product.externalId,
    sku: product.sku,
    productUrl: product.productUrl,
    brandRaw: null,
    titleRaw: product.title,
    price: product.price,
    currency: product.currency,
    availability: product.available == null ? null : product.available ? "in_stock" : "out_of_stock",
    rating: null,
    reviewCount: null,
    unitsSoldText: null,
    rawVariantAttrs: product.variantOptions,
    descriptionText: product.description,
    detailText: product.detailText,
    ingredientText: null,
    factsEvidence: { htmlTable: null, pdfUrl: null, imageRefs: product.images },
    images: product.images,
    sourceFiles: [`products/${product.externalId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`],
    captureCompleteness: "full",
    capturedAt: product.capturedAt,
  };
}

export interface DtcCaptureCatalogOptions {
  url: string;
  runId: string;
  workRoot: string;
  batchSize: number;
  signal: AbortSignal;
  /** 由入口负责从控制面下载好的证据 zip 路径。 */
  archives: string[];
  registerBatch: (batch: { batchId: string; ordinal: number; itemCount: number; batchDirectory: string; imagesRequired: boolean }) => Promise<unknown>;
  beforePublish?: (() => Promise<void>) | undefined;
  finalizeCatalog: (catalog: { inputKind: "brand_catalog" | "product" | "search"; exhausted: boolean; truncated: boolean; expectedCount: number | null; discoveredCount: number; processedCount: number }) => Promise<unknown>;
}

export type DtcCaptureCatalogResult =
  | { status: "complete"; itemCount: number; batchCount: number; recordCount: number; summary: string }
  | { status: "needs_review"; reasonCode: string; summary: string; itemCount: number; batchCount: number };

/**
 * v2 capture_catalog（DTC）：解包 Windows 证据 -> records.json -> CapturedProductBatchV1。
 * 证据解包到 run 级目录（不是 job 级），后续图片线可以直接读同一批本地图片。
 */
export async function runDtcCaptureCatalog(options: DtcCaptureCatalogOptions): Promise<DtcCaptureCatalogResult> {
  const root = runRoot(options.workRoot, options.runId);
  const evidenceRoot = path.join(root, "evidence");
  await fs.mkdir(evidenceRoot, { recursive: true });
  if (options.archives.length === 0) {
    return { status: "needs_review", reasonCode: "dtc_no_evidence", summary: "capture 阶段没有产出证据包", itemCount: 0, batchCount: 0 };
  }

  const capturedAt = new Date().toISOString();
  const products: DtcRawProduct[] = [];
  let recordCount = 0;
  for (const [index, archive] of options.archives.entries()) {
    const directory = path.join(evidenceRoot, String(index).padStart(4, "0"));
    if (!await fs.stat(directory).catch(() => null)) await extractZipSafe(archive, directory);
    const recordsFile = path.join(directory, "evidence", "records.json");
    const raw = await fs.readFile(recordsFile, "utf8").catch(() => null);
    let records: EvidenceRecord[] | null = null;
    if (raw) { const parsed = JSON.parse(raw); records = Array.isArray(parsed) ? parsed as EvidenceRecord[] : null; }
    // Windows browser-node 的 EvidenceBundleV1 描述符格式
    if (!records) records = await readWindowsBundle(directory);
    if (!records) continue;
    recordCount += records.length;
    for (const record of records) products.push(...recordToProducts(record, directory, capturedAt));
  }
  if (products.length === 0) {
    return { status: "needs_review", reasonCode: "dtc_no_products", summary: `解包 ${recordCount} 条记录但没有形成可用商品`, itemCount: 0, batchCount: 0 };
  }

  const publisher = new BatchPublisher<DtcRawProduct>({
    channel: "dtc",
    adapter: null,
    sourceType: "dtc_browser",
    url: options.url,
    runId: options.runId,
    workRoot: options.workRoot,
    batchSize: options.batchSize,
    key: (product) => product.externalId.replace(/[^a-zA-Z0-9_.-]/g, "_"),
    toContract: toDtcCapturedProduct,
    imagesRequired: (batch) => batch.some((product) => product.localImages.length > 0),
    registerBatch: options.registerBatch,
    ...(options.beforePublish ? { beforePublish: options.beforePublish } : {}),
  });
  await publisher.init();
  for (const product of products) await publisher.add(product);
  await publisher.flush();

  await writeJsonAtomic(path.join(root, "capture", "capture.json"), {
    archiveCount: options.archives.length,
    recordCount,
    productCount: products.length,
    batchCount: publisher.batchCount,
  });
  // 独立站的目录完整性由 Skill 端保证；这里按 brand_catalog + 已穷尽上报，
  // 真正的 full/partial 仍由 catalog_finalize 统一裁决（迁移期恒为 partial）。
  await options.finalizeCatalog({
    inputKind: "brand_catalog",
    exhausted: true,
    truncated: false,
    expectedCount: null,
    discoveredCount: products.length,
    processedCount: products.length,
  });
  return {
    status: "complete",
    itemCount: products.length,
    batchCount: publisher.batchCount,
    recordCount,
    summary: `DTC 转换完成：${recordCount} 条记录 -> ${products.length} 个商品，Batch ${publisher.batchCount}`,
  };
}
