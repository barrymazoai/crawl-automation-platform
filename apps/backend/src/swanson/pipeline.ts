import fs from "node:fs/promises";
import path from "node:path";
import type { OcrClient } from "@crawl-automation/ocr-client";
import { buildOcrTextLabelPrompt, mapWithConcurrency, selectFactsOcrImages, type IndexedOcrImage } from "../amazon/ocr-label-pipeline.js";
import { extractLabelJsonWithRepair, type StoredRawLabelVerdict } from "../amazon/label-extraction.js";
import { parseLabel, scoreConfidence } from "../amazon/label-parse.js";
import { chunk } from "../amazon/semantic-clean.js";
import { buildGncBatchPrompt, parseGncBatchOutput, type GncCleanInput, type GncCleanResult } from "../gnc/semantic.js";
import { canonicalVariantForm, runProductUnify, type ProductUnifyInput, type ProductUnifyOutcome, type ProductUnifyResult, type ProductVariant } from "../product-unify.js";
import type { ProductObservationClient } from "../product-observation-client.js";
import { decideSalesChannelScope } from "../sales-channel-scope.js";
import { normalizedProductSchema, productBatchSchema, type NormalizedProduct, type ProductBatch, type ProductFacts, type SupplySmartDatabase } from "../supply-smart-ingest.js";

type ModelCall = (input: { prompt: string; tag: string }) => Promise<string>;

/** discoverCatalog / captureProducts 需要的最小选项集。 */
export interface SwansonCaptureOptions {
  url: string;
  maxItems: number;
  signal: AbortSignal;
}

/** extractFacts 需要的最小选项集。 */
export interface SwansonFactsOptions {
  jobDirectory: string;
  runId: string;
  ocrConcurrency: number;
  ocr: OcrClient;
  runModel: ModelCall;
}

export interface SwansonPipelineOptions {
  url: string;
  runId: string;
  jobDirectory: string;
  maxItems: number;
  ocrConcurrency: number;
  signal: AbortSignal;
  ocr: OcrClient;
  supplySmart: SupplySmartDatabase;
  productWriter: ProductObservationClient;
  runModel: ModelCall;
}

export type SwansonPipelineResult =
  | { status: "complete"; itemCount: number; discoveredCount: number; excludedCount: number; factsCount: number; readbackHash: string; summary: string }
  | { status: "needs_review"; reasonCode: string; summary: string; itemCount: number };

interface ConstructorVariationData {
  url?: string;
  count?: number;
  flavor?: string;
  potent?: string;
  pfdesc?: string;
  stock_sts?: string;
  stock_sts_c?: string;
  image_url?: string;
  product_id?: number;
  variant_id?: number;
  description?: string;
  main_ingred?: string;
  parent_title?: string;
  variation_id?: string;
  flagship_item?: string;
}

interface ConstructorResult {
  value?: string;
  data?: ConstructorVariationData & { id?: string; brand?: string; form?: string; review_rate?: number; nbr_reviews?: number; new_date?: string };
  variations?: Array<{ value?: string; data?: ConstructorVariationData }>;
}

interface ShopifyVariant {
  id: number;
  title: string;
  sku: string | null;
  barcode: string | null;
  available: boolean;
  price: number;
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  description: string;
  published_at: string | null;
  vendor: string;
  available: boolean;
  variants: ShopifyVariant[];
  images: string[];
  media?: Array<{ media_type?: string; src?: string; alt?: string }>;
  options?: Array<{ name?: string; position?: number; values?: string[] }>;
  url: string;
}

interface CatalogEntry {
  handle: string;
  title: string;
  brand: string;
  form: string | null;
  rating: number | null;
  reviewCount: number | null;
  familyParentId: string | null;
  data: ConstructorVariationData;
}

export interface SwansonCatalog {
  inputKind: "brand_catalog" | "product" | "search";
  entries: CatalogEntry[];
  expectedCount: number | null;
  exhausted: boolean;
  truncated: boolean;
  pageCount: number;
}

export interface CapturedSwansonProduct {
  externalId: string;
  sku: string | null;
  product: ShopifyProduct;
  variant: ShopifyVariant;
  catalog: CatalogEntry;
  productUrl: string;
  images: string[];
  capturedAt: string;
}

const REQUEST_HEADERS = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36" };

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Swanson pipeline aborted");
}

async function fetchText(url: string, signal: AbortSignal) {
  const response = await fetch(url, { headers: REQUEST_HEADERS, signal });
  if (!response.ok) throw new Error(`Swanson HTTP ${response.status}: ${url}`);
  return response.text();
}

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  return JSON.parse(await fetchText(url, signal)) as T;
}

async function writeJson(filename: string, value: unknown) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filename);
}

async function readJson<T>(filename: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(filename, "utf8")) as T; }
  catch { return null; }
}

function number(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function productHandle(url: string) {
  return new URL(url).pathname.match(/^\/products\/([^/?#]+)/i)?.[1] ?? null;
}

function absoluteImage(value: string) {
  return value.startsWith("//") ? `https:${value}` : new URL(value, "https://www.swansonvitamins.com").toString();
}

function catalogEntry(result: ConstructorResult, data: ConstructorVariationData): CatalogEntry | null {
  if (!data.url) return null;
  return {
    handle: data.url.replace(/^\/+|\/+$/g, "").replace(/^products\//, ""),
    title: data.description?.trim() || result.value?.trim() || "",
    brand: result.data?.brand?.trim() || "",
    form: result.data?.form?.trim() || null,
    rating: number(result.data?.review_rate),
    reviewCount: number(result.data?.nbr_reviews),
    familyParentId: result.data?.id?.trim() || null,
    data,
  };
}

export function parseSwansonConstructorPage(value: unknown) {
  const response = (value as any)?.response ?? {};
  const results = Array.isArray(response.results) ? response.results as ConstructorResult[] : [];
  const entries = results.flatMap((result) => {
    const values = [result.data, ...(result.variations ?? []).map((variation) => variation.data)]
      .filter((item): item is ConstructorVariationData => Boolean(item));
    const unique = new Map<string, CatalogEntry>();
    for (const data of values) {
      const entry = catalogEntry(result, data);
      if (entry?.handle) unique.set(entry.handle, entry);
    }
    return [...unique.values()];
  });
  return { total: number(response.total_num_results), resultCount: results.length, entries };
}

export async function discoverCatalog(options: SwansonCaptureOptions): Promise<SwansonCatalog> {
  const direct = productHandle(options.url);
  if (direct) {
    return {
      inputKind: "product",
      entries: [{ handle: direct, title: "", brand: "", form: null, rating: null, reviewCount: null, familyParentId: null, data: { url: direct } }],
      expectedCount: 1,
      exhausted: true,
      truncated: false,
      pageCount: 0,
    };
  }
  const source = new URL(options.url);
  const brand = source.searchParams.get("facet.brand")?.trim() || null;
  const html = await fetchText(source.toString(), options.signal);
  const apiKey = html.match(/constructorApiKey\s*=\s*['"]([^'"]+)/)?.[1];
  const filterName = html.match(/var FILTER_NAME\s*=\s*['"]([^'"]+)/)?.[1];
  const filterValue = html.match(/var FILTER_VALUE\s*=\s*['"]([^'"]+)/)?.[1];
  if (!apiKey || !filterName || !filterValue) throw new Error("Swanson 目录页缺少 Constructor API 配置");

  const entries = new Map<string, CatalogEntry>();
  let expectedCount: number | null = null;
  let fetchedResultCount = 0;
  let page = 0;
  let truncated = false;
  const perPage = 100;
  while (expectedCount == null || fetchedResultCount < expectedCount) {
    assertNotAborted(options.signal);
    page += 1;
    const endpoint = new URL(`https://ac.cnstrc.com/browse/${encodeURIComponent(filterName)}/${encodeURIComponent(filterValue)}`);
    endpoint.searchParams.set("key", apiKey);
    endpoint.searchParams.set("page", String(page));
    endpoint.searchParams.set("num_results_per_page", String(perPage));
    if (brand) endpoint.searchParams.append("filters[brand][]", brand);
    const parsed = parseSwansonConstructorPage(await fetchJson(endpoint.toString(), options.signal));
    expectedCount = parsed.total;
    fetchedResultCount += parsed.resultCount;
    for (const entry of parsed.entries) {
      if (entries.size >= options.maxItems && !entries.has(entry.handle)) { truncated = true; continue; }
      entries.set(entry.handle, entry);
    }
    if (parsed.resultCount === 0) break;
    if (truncated) break;
  }
  return {
    inputKind: brand && /^\/collections\/all\/?$/i.test(source.pathname) ? "brand_catalog" : "search",
    entries: [...entries.values()],
    expectedCount,
    exhausted: !truncated && expectedCount != null && fetchedResultCount >= expectedCount,
    truncated,
    pageCount: page,
  };
}

export async function captureProducts(options: SwansonCaptureOptions, catalog: SwansonCatalog) {
  const products = await mapWithConcurrency(catalog.entries, 4, async (entry) => {
    assertNotAborted(options.signal);
    const productUrl = `https://www.swansonvitamins.com/products/${entry.handle}`;
    const product = await fetchJson<ShopifyProduct>(`${productUrl}.js`, options.signal);
    const images = [...new Set([
      ...(product.media ?? []).filter((item) => item.media_type === "image" && item.src).map((item) => absoluteImage(item.src!)),
      ...product.images.map(absoluteImage),
    ])];
    return product.variants.map((variant): CapturedSwansonProduct => ({
      externalId: variant.sku?.trim() || `shopify_variant:${variant.id}`,
      sku: variant.sku?.trim() || null,
      product,
      variant,
      catalog: { ...entry, title: entry.title || product.title, brand: entry.brand || product.vendor },
      productUrl,
      images,
      capturedAt: new Date().toISOString(),
    }));
  });
  return products.flat();
}

export function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

async function downloadImages(product: CapturedSwansonProduct, root: string, concurrency: number) {
  const directory = path.join(root, product.externalId.replace(/[^a-zA-Z0-9_-]/g, "_"));
  await fs.mkdir(directory, { recursive: true });
  return mapWithConcurrency(product.images, concurrency, async (url, index) => {
    const filename = path.join(directory, `${String(index).padStart(2, "0")}.jpg`);
    if (await fs.stat(filename).catch(() => null)) return filename;
    const response = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${product.externalId}: 图片下载失败 HTTP ${response.status}`);
    await fs.writeFile(filename, Buffer.from(await response.arrayBuffer()));
    return filename;
  });
}

export async function extractFacts(options: SwansonFactsOptions, product: CapturedSwansonProduct): Promise<{ facts: ProductFacts | null; labelText: string | null; ingredients: string[]; review: string | null }> {
  if (product.images.length === 0) return { facts: null, labelText: null, ingredients: [], review: null };
  const images = await downloadImages(product, path.join(options.jobDirectory, "swanson", "images"), options.ocrConcurrency);
  const ocrImages = await mapWithConcurrency(images, options.ocrConcurrency, async (filename, index): Promise<IndexedOcrImage> => {
    const cache = `${filename}.ocr.json`;
    let response = await readJson<any>(cache);
    if (!response) { response = await options.ocr.recognize(filename); await writeJson(cache, response); }
    return { index, fileName: path.basename(filename), response };
  });
  const selected = selectFactsOcrImages(ocrImages);
  if (selected.length === 0) return { facts: null, labelText: null, ingredients: [], review: null };
  const resultFile = path.join(options.jobDirectory, "swanson", "images", product.externalId.replace(/[^a-zA-Z0-9_-]/g, "_"), "label.raw.json");
  const stored = await readJson<StoredRawLabelVerdict>(resultFile);
  const prompt = `${buildOcrTextLabelPrompt(selected)}\nIMPORTANT: Return one object with one string field named payload, and serialize the requested JSON object exactly inside payload.`;
  const verdict = await extractLabelJsonWithRepair({
    prompt,
    tag: `swanson-label-${product.externalId}`,
    runModel: options.runModel,
    stored,
  });
  if (!stored || stored.raw !== verdict.raw || stored.parsed !== verdict.parsed) await writeJson(resultFile, verdict);
  const label = verdict.parsed;
  if (label?.ambiguous) return { facts: null, labelText: verdict.raw ?? null, ingredients: [], review: `${product.externalId}: OCR 发现多张不同配方` };
  if (label?.skip) return { facts: null, labelText: verdict.raw ?? null, ingredients: [], review: null };
  const parsed = parseLabel(label);
  if (!parsed) return { facts: null, labelText: verdict.raw ?? null, ingredients: [], review: `${product.externalId}: Facts 语义解析失败` };
  const facts: ProductFacts = {
    channel: "swanson",
    externalId: product.externalId,
    sourceUrl: product.productUrl,
    capturedAt: product.capturedAt,
    source: `crawl-automation:${options.runId}:label_ocr`,
    confidence: scoreConfidence(label!, parsed),
    ...(product.images[selected[0]!.index] ? { sourceImageUrl: product.images[selected[0]!.index] } : {}),
    servingSize: parsed.servingSize,
    servingUnit: parsed.servingUnit,
    servingsPerContainer: parsed.servingsPerContainer,
    rows: parsed.rows.map((row) => ({
      name: row.rawText,
      amountValue: row.amountValue,
      amountUnit: row.amountUnit,
      dvPercent: row.dvPercent,
      position: row.position,
      isActive: row.isActive,
      parentPosition: row.parentIndex == null ? null : parsed.rows[row.parentIndex]?.position ?? null,
    })),
  };
  return { facts, labelText: verdict.raw ?? null, ingredients: parsed.rows.filter((row) => row.isActive).map((row) => row.rawText), review: null };
}

function swansonSize(value: string | undefined, count: number | undefined) {
  if (count && Number.isFinite(count) && count > 0) return `${count} Count`;
  const matches = [...(value ?? "").matchAll(/(\d+(?:\.\d+)?)\s*(fl\s*oz|oz|lb|kg|g|ml|l|counts?|ct|capsules?|caps?|tablets?|tabs?|softgels?|gummies?|packets?|sticks?)/gi)];
  const match = matches.find((item) => /^(?:fl\s*oz|oz|lb|kg|g|ml|l)$/i.test(item[2] ?? "")) ?? matches.at(-1);
  if (!match?.[1] || !match[2]) return undefined;
  const unit = match[2].replace(/\s+/g, " ").toLowerCase();
  if (/^(?:counts?|ct|capsules?|caps?|tablets?|tabs?|softgels?|gummies?|packets?|sticks?)$/.test(unit)) return `${match[1]} Count`;
  return `${match[1]} ${unit === "fl oz" ? "fl oz" : unit}`;
}

export function swansonVariantAttrsFromRaw(input: {
  flavor?: string | null;
  option1?: string | null;
  count?: number;
  pfdesc?: string;
  potent?: string;
  form?: string | null;
}) {
  const candidateFlavor = input.flavor || input.option1 || undefined;
  const flavor = candidateFlavor && !/^default title$/i.test(candidateFlavor.trim()) ? candidateFlavor : undefined;
  const size = swansonSize(input.pfdesc, input.count);
  const form = canonicalVariantForm(input.form)
    ?? canonicalVariantForm((input.pfdesc ?? "").match(/\b(pwdrs?|powders?|capsules?|caps?|tablets?|tabs?|softgels?|gummies?|liquids?)\b/i)?.[1]);
  return Object.fromEntries(Object.entries({
    flavor,
    size,
    strength: input.potent || undefined,
    form,
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim())));
}

function variantAttrs(product: CapturedSwansonProduct) {
  const data = product.catalog.data;
  return swansonVariantAttrsFromRaw({
    ...(data.flavor ? { flavor: data.flavor } : {}),
    option1: product.variant.option1,
    ...(data.count ? { count: data.count } : {}),
    ...(data.pfdesc ? { pfdesc: data.pfdesc } : {}),
    ...(data.potent ? { potent: data.potent } : {}),
    form: product.catalog.form,
  });
}

function structuredVariant(product: CapturedSwansonProduct, semantic: GncCleanResult) {
  const attrs = variantAttrs(product);
  const variant: ProductVariant = {};
  if (attrs.flavor) variant.flavor = attrs.flavor;
  if (attrs.size) variant.size = attrs.size;
  if (attrs.strength) variant.strength = attrs.strength;
  const form = canonicalVariantForm(attrs.form) ?? canonicalVariantForm(semantic.productForm);
  if (form) variant.form = form;
  return variant;
}

export function unifyInput(product: CapturedSwansonProduct, semantic: GncCleanResult): ProductUnifyInput {
  const attrs = variantAttrs(product);
  return {
    clientRef: product.externalId,
    channel: "swanson",
    titleRaw: product.product.title,
    brand: product.catalog.brand,
    structuredVariant: structuredVariant(product, semantic),
    attrsRaw: attrs,
    productFormHint: semantic.productForm === "other" ? null : semantic.productForm,
  };
}

function normalizeGtin(value: string | null) {
  const digits = value?.replace(/\D/g, "") ?? "";
  return /^(?:\d{8}|\d{12,14})$/.test(digits) ? digits : undefined;
}

export function normalizeProduct(product: CapturedSwansonProduct, semantic: GncCleanResult, unified: ProductUnifyResult, domain: string, runId: string, crawlScope: "full" | "partial"): NormalizedProduct {
  const attrs = variantAttrs(product);
  const variant = { ...unified.variant, ...structuredVariant(product, semantic) };
  if (variant.flavor && /^default title$/i.test(variant.flavor)) delete variant.flavor;
  return normalizedProductSchema.parse({
    domain,
    productName: unified.productName,
    titleRaw: product.product.title,
    productUrl: product.productUrl,
    channel: "swanson",
    externalId: product.externalId,
    sourceUrl: product.productUrl,
    capturedAt: product.capturedAt,
    crawlScope,
    source: `crawl-automation:${runId}`,
    sku: product.sku,
    skuMissing: product.sku == null,
    price: (product.variant.price / 100).toFixed(2),
    currency: "USD",
    inStock: product.variant.available,
    ...(product.catalog.rating != null ? { rating: product.catalog.rating } : {}),
    ...(product.catalog.reviewCount != null ? { reviewCount: Math.trunc(product.catalog.reviewCount) } : {}),
    ...(product.product.published_at ? { listedAt: new Date(product.product.published_at).toISOString(), listedAtSource: "swanson_published_at" } : {}),
    images: product.images,
    healthFunctions: semantic.healthFunctions,
    mainIngredients: semantic.ingredients,
    productForm: semantic.productForm,
    nutritionScope: { policy: "nutrition_single_products", decision: "included", evidence: semantic.scopeEvidence },
    ...(normalizeGtin(product.variant.barcode) ? { gtin: normalizeGtin(product.variant.barcode) } : {}),
    ...(unified.baseName ? { baseName: unified.baseName } : {}),
    variant,
    variantConfidence: unified.variantConfidence,
    variantSource: unified.variantSource,
    attrsRaw: unified.attrsRaw,
    variantAttrs: attrs,
    extras: { swansonProductId: product.product.id, swansonVariantId: product.variant.id },
    family: product.catalog.familyParentId ? { parentExternalId: product.catalog.familyParentId, label: attrs.flavor ?? attrs.size ?? product.product.title, evidence: "explicit" } : null,
  });
}


// v1 单体编排 runSwansonPipeline 已删除：Swanson 现在走 workers/capture-swanson.ts + v2/channels/swanson.ts
