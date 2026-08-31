import fs from "node:fs/promises";
import path from "node:path";
import type { OcrClient } from "@crawl-automation/ocr-client";
import { createPageHolder } from "./browser.js";
import {
  MAX_SEARCH_PAGES,
  SEARCH_PAGE_SCRIPT,
  VARIATION_PAGE_SCRIPT,
  parseSearchPage,
  type RawSearchPage,
  type RawVariationPage,
} from "./amazon-search.js";
import { extractVariationFamily, type VariationFamily } from "./link-check.js";
import { extractProduct, type ExtractedProduct } from "./extract-product.js";
import { readSnapshot, saveSnapshot } from "./snapshot.js";
import {
  buildBatchPrompt,
  chunk,
  extractLastJsonArray,
  parseBatchOutput,
  type CleanInput,
  type CleanResult,
} from "./semantic-clean.js";
import {
  buildOcrTextLabelPrompt,
  mapWithConcurrency,
  selectFactsOcrImages,
  type IndexedOcrImage,
} from "./ocr-label-pipeline.js";
import { extractLabelJsonWithRepair, type StoredRawLabelVerdict } from "./label-extraction.js";
import { parseLabel, scoreConfidence } from "./label-parse.js";
import { toEnrichPayload } from "./to-enrich-payload.js";
import {
  normalizedProductSchema,
  productBatchSchema,
  type NormalizedProduct,
  type ProductBatch,
  type ProductFacts,
  type SupplySmartDatabase,
} from "../supply-smart-ingest.js";
import {
  canonicalVariantForm,
  canonicalVariantStrength,
  runProductUnify,
  type ProductUnifyInput,
  type ProductUnifyOutcome,
  type ProductUnifyResult,
  type ProductVariant,
} from "../product-unify.js";
import type { ProductObservationClient } from "../product-observation-client.js";
import { decideSalesChannelScope, type SalesChannelInputKind } from "../sales-channel-scope.js";

const ASIN_RE = /^[A-Z0-9]{10}$/;
const SEMANTIC_POLICY_VERSION = 3;
const INGREDIENT_FALLBACK_VERSION = 2;
const GENERIC_ASIN_SCRIPT = `(() => ({
  blocked: document.documentElement.innerHTML.includes('validateCaptcha') ||
    document.body.innerText.includes('Enter the characters you see below'),
  asins: [...new Set([...document.querySelectorAll('a[href*="/dp/"],a[href*="/gp/product/"]')]
    .map(a => (a.getAttribute('href') || '').match(/\\/(?:dp|gp\\/product)\\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase())
    .filter(Boolean))]
}))()`;

export const BRAND_STORE_SCRIPT = `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let stable = 0;
  let previousHeight = 0;
  for (let index = 0; index < 30 && stable < 3; index += 1) {
    const button = [...document.querySelectorAll('button,a')].find((node) => /load more|show more|see more/i.test((node.textContent || '').trim()) && !node.disabled);
    if (button) button.click();
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(350);
    const height = document.documentElement.scrollHeight;
    stable = height === previousHeight && !button ? stable + 1 : 0;
    previousHeight = height;
  }
  const html = document.documentElement.innerHTML;
  const text = document.body?.innerText || '';
  const anchors = [...document.querySelectorAll('a[href]')];
  const asinValues = [
    ...[...document.querySelectorAll('[data-asin]')].map((node) => node.getAttribute('data-asin')),
    ...anchors.map((node) => (node.getAttribute('href') || '').match(/\\/(?:dp|gp\\/product)\\/([A-Z0-9]{10})/i)?.[1]),
  ];
  return {
    blocked: html.includes('validateCaptcha') || /Enter the characters you see below|Continue shopping/i.test(text),
    asins: [...new Set(asinValues.filter((value) => /^[A-Z0-9]{10}$/i.test(value || '')).map((value) => value.toUpperCase()))],
    storeLinks: [...new Set(anchors.map((node) => node.href).filter((href) => /amazon\\.[^/]+\\/stores\\//i.test(href)))],
    hasAllProductsSignal: anchors.some((node) => /all products|shop all/i.test((node.textContent || '').trim())) || /all products|shop all/i.test(document.title),
  };
})()`;

type ModelCall = (input: { prompt: string; tag: string }) => Promise<string>;

export interface AmazonPipelineOptions {
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

export type AmazonPipelineResult =
  | { status: "complete"; itemCount: number; discoveredCount: number; excludedCount: number; factsCount: number; readbackHash: string; summary: string }
  | { status: "needs_review"; reasonCode: string; summary: string; itemCount: number };

export type CapturedProduct = {
  asin: string;
  capturedAt: string;
  extracted: ExtractedProduct;
  family: VariationFamily;
  familyLabel: string | null;
};

/** captureProducts 需要的最小选项集（v2 抓取 Adapter 复用时不必构造完整 AmazonPipelineOptions）。 */
export interface AmazonCaptureOptions {
  url: string;
  jobDirectory: string;
  maxItems: number;
  signal: AbortSignal;
  /** v2：每成功抓到一个商品（含缓存命中）立即回调，用于边抓边发布 Batch。 */
  onProduct?: (product: CapturedProduct) => void | Promise<void>;
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Amazon pipeline aborted");
}

async function exists(filename: string) {
  return Boolean(await fs.stat(filename).catch(() => null));
}

async function writeJson(filename: string, value: unknown) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, filename);
}

async function readJson<T>(filename: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8")) as T;
  } catch {
    return null;
  }
}

function directAsin(url: string) {
  return new URL(url).pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() ?? null;
}

function pageUrl(source: string, page: number) {
  const url = new URL(source);
  if (page > 1) url.searchParams.set("page", String(page));
  else url.searchParams.delete("page");
  return url.toString();
}

function brandHint(url: string) {
  const value = new URL(url).searchParams.get("k") ?? new URL(url).searchParams.get("field-keywords") ?? "Amazon";
  return value.trim() || "Amazon";
}

export interface AmazonDiscoveryResult {
  asins: string[];
  inputKind: SalesChannelInputKind;
  pageCount: number;
  expectedCount: number | null;
  exhausted: boolean;
  truncated: boolean;
}

export function amazonInputKind(url: string): SalesChannelInputKind {
  if (directAsin(url)) return "product";
  return /\/stores\//i.test(new URL(url).pathname) ? "brand_catalog" : "search";
}

function storeBrandKey(url: string) {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  const index = segments.findIndex((value) => value.toLowerCase() === "stores");
  const key = segments[index + 1];
  return key && key.toLowerCase() !== "page" ? decodeURIComponent(key).toLowerCase() : null;
}

export async function discoverInitialAsins(url: string, maxItems: number): Promise<AmazonDiscoveryResult> {
  const direct = directAsin(url);
  if (direct) return { asins: [direct], inputKind: "product", pageCount: 0, expectedCount: 1, exhausted: true, truncated: false };

  if (amazonInputKind(url) === "brand_catalog") {
    const holder = createPageHolder();
    const brandKey = storeBrandKey(url);
    const start = new URL(url);
    start.hash = "";
    start.search = "";
    const queued = [start.toString()];
    const visited = new Set<string>();
    const seen = new Set<string>();
    let truncated = false;
    let hasAllProductsSignal = false;
    try {
      for (let cursor = 0; cursor < queued.length; cursor += 1) {
        if (visited.size >= 100) { truncated = true; break; }
        const current = queued[cursor]!;
        if (visited.has(current)) continue;
        visited.add(current);
        const raw = await holder.run(async (browser) => {
          const status = await browser.navigate(current);
          const value = await browser.evaluate<{ blocked: boolean; asins: string[]; storeLinks: string[]; hasAllProductsSignal: boolean }>(BRAND_STORE_SCRIPT);
          return { status, value };
        });
        if (raw.value.blocked) throw new Error(`Amazon Brand Store 被挑战页拦截：${current}`);
        if (raw.status >= 400) throw new Error(`Amazon Brand Store 不可读 HTTP ${raw.status}: ${current}`);
        hasAllProductsSignal ||= raw.value.hasAllProductsSignal;
        for (const asin of raw.value.asins) {
          if (seen.size >= maxItems) { truncated = true; break; }
          seen.add(asin);
        }
        for (const candidate of raw.value.storeLinks) {
          const normalized = new URL(candidate);
          normalized.hash = "";
          normalized.search = "";
          const value = normalized.toString();
          if (normalized.origin !== new URL(url).origin || visited.has(value) || queued.includes(value)) continue;
          const candidateKey = storeBrandKey(value);
          if (brandKey && candidateKey && candidateKey !== brandKey) continue;
          queued.push(value);
        }
        if (truncated) break;
      }
    } finally { await holder.close(); }
    return {
      asins: [...seen],
      inputKind: "brand_catalog",
      pageCount: visited.size,
      expectedCount: null,
      exhausted: !truncated && visited.size === queued.length && hasAllProductsSignal,
      truncated,
    };
  }

  const holder = createPageHolder();
  const seen = new Set<string>();
  let pageCount = 0;
  let exhausted = false;
  try {
    for (let page = 1; page <= MAX_SEARCH_PAGES && seen.size < maxItems; page += 1) {
      pageCount = page;
      const raw = await holder.run(async (browser) => {
        await browser.navigate(pageUrl(url, page));
        return browser.evaluate<RawSearchPage>(SEARCH_PAGE_SCRIPT);
      });
      if (raw.blocked) throw new Error(`Amazon 搜索第 ${page} 页被挑战页拦截`);
      const parsed = parseSearchPage(raw, brandHint(url), seen);
      if (parsed.results.length === 0) {
        if (page === 1) {
          const generic = await holder.run(async (browser) => browser.evaluate<{ blocked: boolean; asins: string[] }>(GENERIC_ASIN_SCRIPT));
          if (generic.blocked) throw new Error("Amazon 页面被挑战页拦截");
          for (const asin of generic.asins ?? []) if (ASIN_RE.test(asin)) seen.add(asin);
        }
        exhausted = true;
        break;
      }
    }
  } finally {
    await holder.close();
  }
  return {
    asins: [...seen].slice(0, maxItems),
    inputKind: "search",
    pageCount,
    expectedCount: null,
    exhausted,
    truncated: !exhausted || seen.size >= maxItems,
  };
}

function labelForAsin(family: VariationFamily, asin: string) {
  return family.members.find((member) => member.asin === asin)?.label?.trim() || null;
}

export async function captureProducts(options: AmazonCaptureOptions, initial: string[]) {
  const root = path.join(options.jobDirectory, "amazon");
  const pageDirectory = path.join(root, "pages");
  const extractedDirectory = path.join(root, "extracted");
  const holder = createPageHolder();
  const queued = [...initial];
  const known = new Set(queued);
  const products: CapturedProduct[] = [];
  let variantOverflow = false;

  try {
    for (let cursor = 0; cursor < queued.length && products.length < options.maxItems; cursor += 1) {
      assertNotAborted(options.signal);
      const asin = queued[cursor]!;
      const extractedFile = path.join(extractedDirectory, `${asin}.json`);
      const cached = await readJson<CapturedProduct>(extractedFile);
      if (cached) {
        await options.onProduct?.(cached);
        products.push(cached);
        for (const member of cached.family.members) {
          if (!known.has(member.asin) && known.size < options.maxItems) { known.add(member.asin); queued.push(member.asin); }
          else if (!known.has(member.asin)) variantOverflow = true;
        }
        continue;
      }

      let html = await readSnapshot(asin, pageDirectory);
      let family: VariationFamily = { parentAsin: null, members: [] };
      if (!html) {
        const raw = await holder.run(async (browser) => {
          const status = await browser.navigate(`${new URL(options.url).origin}/dp/${asin}`);
          const page = await browser.evaluate<RawVariationPage>(VARIATION_PAGE_SCRIPT);
          return { status, page };
        });
        if (!raw.page.readable || !raw.page.fullHtml) {
          throw new Error(`${asin}: Amazon 商品页不可读（HTTP ${raw.status || "unknown"}）`);
        }
        html = raw.page.fullHtml;
        family = extractVariationFamily(raw.page.fragment || html);
        await saveSnapshot(asin, html, pageDirectory);
      } else {
        family = extractVariationFamily(html);
      }

      for (const member of family.members) {
        if (ASIN_RE.test(member.asin) && !known.has(member.asin) && known.size < options.maxItems) {
          known.add(member.asin);
          queued.push(member.asin);
        } else if (ASIN_RE.test(member.asin) && !known.has(member.asin)) variantOverflow = true;
      }
      const captured: CapturedProduct = {
        asin,
        capturedAt: new Date().toISOString(),
        extracted: extractProduct(html),
        family,
        familyLabel: labelForAsin(family, asin),
      };
      await writeJson(extractedFile, captured);
      await options.onProduct?.(captured);
      products.push(captured);
    }
  } finally {
    await holder.close();
  }
  return { products, queuedCount: known.size, truncated: variantOverflow || products.length < known.size };
}

function cleanInput(product: CapturedProduct): CleanInput {
  return {
    asin: product.asin,
    title: product.extracted.title,
    formField: product.extracted.itemForm,
    bullets: product.extracted.bullets,
    description: product.extracted.description,
    aplusText: product.extracted.aplusText,
    ingredientsRaw: product.extracted.ingredientsText,
  };
}

async function semanticClean(options: AmazonPipelineOptions, products: CapturedProduct[], vocabulary: string[]) {
  const cacheFile = path.join(options.jobDirectory, "amazon", "semantic.json");
  const cached = await readJson<{ policyVersion?: number; results: CleanResult[]; warnings: string[] }>(cacheFile);
  if (cached?.policyVersion === SEMANTIC_POLICY_VERSION) return cached;

  const inputs = products.map(cleanInput);
  const batches = chunk(inputs, 50);
  const outcomes = await mapWithConcurrency(batches, 2, async (batch, index) => {
    const prompt = `${buildBatchPrompt(batch, vocabulary)}\nIMPORTANT: the runner wrapper overrides the earlier top-level output sentence. Return one object with one string field named payload, and put the requested JSON array serialized exactly inside payload.`;
    const payload = await options.runModel({ prompt, tag: `semantic-${index}` });
    return parseBatchOutput(payload, batch, vocabulary);
  });
  const value = {
    policyVersion: SEMANTIC_POLICY_VERSION,
    results: outcomes.flatMap((outcome) => outcome.results),
    warnings: outcomes.flatMap((outcome) => outcome.problems),
  };
  await writeJson(cacheFile, value);
  return value;
}

export function amazonUnifyInput(product: CapturedProduct, semantic: CleanResult): ProductUnifyInput | null {
  const titleRaw = product.extracted.title?.trim();
  if (!titleRaw) return null;
  const structuredVariant: ProductVariant = {};
  if (product.extracted.unitCount?.trim()) structuredVariant.size = product.extracted.unitCount.trim();
  const form = explicitAmazonTitleForm(titleRaw) ?? canonicalVariantForm(product.extracted.itemForm);
  if (form) structuredVariant.form = form;
  return {
    clientRef: product.asin,
    channel: "amazon",
    titleRaw,
    brand: product.extracted.brand,
    structuredVariant,
    attrsRaw: {
      ...(product.extracted.itemForm ? { label: product.extracted.itemForm } : {}),
      ...(product.extracted.unitCount ? { pack: product.extracted.unitCount } : {}),
      ...(product.familyLabel ? { familyLabel: product.familyLabel } : {}),
    },
    productFormHint: semantic.productForm === "other" ? null : semantic.productForm,
  };
}

export function explicitAmazonTitleForm(title: string): ProductVariant["form"] | undefined {
  const match = title.match(
    /\b(capsules?|caplets?|tablets?|soft\s*gels?|gumm(?:y|ies)|chewables?|powders?|liquids?|oils?|sprays?|lozenges?|stick\s*packs?|sachets?|soft\s*chews?|teas?|bars?|pellets?|gels?|creams?)\b/i,
  );
  return match ? canonicalVariantForm(match[1]) : undefined;
}

async function unifyProducts(options: AmazonPipelineOptions, products: CapturedProduct[], semanticByAsin: Map<string, CleanResult>) {
  const cacheFile = path.join(options.jobDirectory, "amazon", "product-unify.json");
  const inputs = products.flatMap((product) => {
    const semantic = semanticByAsin.get(product.asin);
    if (!semantic || semantic.scopeDecision !== "included") return [];
    const input = amazonUnifyInput(product, semantic);
    return input ? [input] : [];
  });
  const cached = await readJson<ProductUnifyOutcome>(cacheFile);
  const normalizeResult = (result: ProductUnifyResult): ProductUnifyResult => ({
    ...result,
    variant: {
      ...result.variant,
      ...(result.variant.strength !== undefined
        ? { strength: canonicalVariantStrength(result.variant.strength) as ProductVariant["strength"] }
        : {}),
    },
  });
  const cachedByRef = new Map((cached?.results ?? []).map((result) => {
    const normalized = normalizeResult(result);
    return [normalized.clientRef, normalized] as const;
  }));
  const missing = inputs.filter((input) => {
    const result = cachedByRef.get(input.clientRef);
    return !result || result.variantConfidence < 70;
  });
  if (cached && missing.length === 0) return cached;
  const repaired = await runProductUnify({
    inputs: missing.length > 0 ? missing : inputs,
    runModel: options.runModel,
    tagPrefix: cached ? "amazon-unify-resume" : "amazon-unify",
    batchSize: 20,
  });
  for (const result of repaired.results) cachedByRef.set(result.clientRef, normalizeResult(result));
  const outcome: ProductUnifyOutcome = {
    results: inputs.map((input) => cachedByRef.get(input.clientRef)).filter((result): result is ProductUnifyResult => Boolean(result)),
    problems: repaired.problems,
  };
  await writeJson(cacheFile, outcome);
  return outcome;
}

function imageExtension(contentType: string | null, url: string) {
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("gif")) return ".gif";
  const match = new URL(url).pathname.match(/\.(png|webp|gif|jpe?g)$/i)?.[0];
  return match?.toLowerCase() ?? ".jpg";
}

async function downloadImages(product: CapturedProduct, root: string, concurrency: number) {
  const directory = path.join(root, product.asin);
  await fs.mkdir(directory, { recursive: true });
  return mapWithConcurrency(product.extracted.images, concurrency, async (url, index) => {
    const stem = String(index).padStart(2, "0");
    const existing = (await fs.readdir(directory)).find((name) => name.startsWith(`${stem}.`) && !name.endsWith(".ocr.json"));
    if (existing) return path.join(directory, existing);
    let response: Response | null = null;
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const candidate = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "Mozilla/5.0" } });
        if (candidate.ok) { response = candidate; break; }
        if (candidate.status < 500 && candidate.status !== 408 && candidate.status !== 429) {
          throw Object.assign(new Error(`${product.asin}: 图片 ${index} 下载失败 HTTP ${candidate.status}`), { retryable: false });
        }
        lastError = new Error(`${product.asin}: 图片 ${index} 下载失败 HTTP ${candidate.status}`);
      } catch (error) {
        if ((error as { retryable?: boolean }).retryable === false) throw error;
        lastError = error;
      }
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
    if (!response) throw lastError instanceof Error ? lastError : new Error(`${product.asin}: 图片 ${index} 下载失败`);
    const filename = path.join(directory, `${stem}${imageExtension(response.headers.get("content-type"), url)}`);
    await fs.writeFile(filename, Buffer.from(await response.arrayBuffer()));
    return filename;
  });
}

export interface AmazonFactsExtraction {
  facts: ProductFacts | null;
  imageIngredients: string[];
  review?: string;
}

export function parseImageIngredientOutput(raw: string) {
  const rows = extractLastJsonArray(raw) ?? [];
  return [...new Set(rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const name = String((row as Record<string, unknown>).name ?? "").trim().replace(/\s+/g, " ");
    return name ? [name] : [];
  }))];
}

async function extractImageIngredients(
  options: AmazonPipelineOptions,
  product: CapturedProduct,
  ocrImages: IndexedOcrImage[],
) {
  const cacheFile = path.join(options.jobDirectory, "amazon", "images", product.asin, "image-ingredients.raw.json");
  const cached = await readJson<{ policyVersion?: number; raw: string; ingredients: string[] }>(cacheFile);
  if (cached?.policyVersion === INGREDIENT_FALLBACK_VERSION) return cached.ingredients;
  const pageEvidence = [
    `TITLE: ${product.extracted.title ?? ""}`,
    `BULLETS: ${(product.extracted.bullets ?? "").slice(0, 4_000)}`,
    `DESCRIPTION: ${(product.extracted.description ?? "").slice(0, 2_000)}`,
    `APLUS: ${(product.extracted.aplusText ?? "").slice(0, 2_000)}`,
    `INGREDIENTS_RAW: ${(product.extracted.ingredientsText ?? "").slice(0, 2_000)}`,
  ].join("\n");
  const ocrEvidence = ocrImages.map((image) => {
    const text = String((image.response as { text?: unknown }).text ?? "").trim().slice(0, 1_500);
    return `IMAGE ${String(image.index).padStart(2, "0")} OCR:\n${text}`;
  }).join("\n\n");
  const prompt = `You extract explicitly printed ingredient names from page text and OCR text for one oral nutrition product.
Use only the evidence below. Do not use outside knowledge and do not infer an ingredient from a product name or health claim.
Accept a name only when the evidence literally identifies it as an ingredient/content, such as "with Grass-Fed Liver, Heart and Kidney", "including mulberry and guava", "enhanced with Bacillus subtilis AB22", "formulated with ...", or an ingredient list.
Reject brands, dosage forms, certifications, directions, benefits, body organs mentioned only in claims, and words that are not ingredient names.
Return ONLY a JSON array: [{"name":"exact ingredient text","evidence":"short exact OCR excerpt"}]. Return [] when no ingredient is explicitly named.
IMPORTANT: Return one object with one string field named payload, and serialize that JSON array exactly inside payload.

PAGE TEXT:\n${pageEvidence}\n\nOCR TEXT:\n${ocrEvidence}`;
  const raw = await options.runModel({ prompt, tag: `image-ingredients-${product.asin}` });
  const ingredients = parseImageIngredientOutput(raw);
  await writeJson(cacheFile, { policyVersion: INGREDIENT_FALLBACK_VERSION, raw, ingredients });
  return ingredients;
}

export async function extractFacts(
  options: AmazonPipelineOptions,
  product: CapturedProduct,
  needsIngredientFallback: boolean,
): Promise<AmazonFactsExtraction> {
  if (product.extracted.images.length === 0) return { facts: null, imageIngredients: [] };
  const images = await downloadImages(product, path.join(options.jobDirectory, "amazon", "images"), options.ocrConcurrency);
  const ocrImages = await mapWithConcurrency(images, options.ocrConcurrency, async (filename, index): Promise<IndexedOcrImage> => {
    const cache = `${filename}.ocr.json`;
    let response = await readJson<any>(cache);
    if (!response) {
      response = await options.ocr.recognize(filename);
      await writeJson(cache, response);
    }
    return { index, fileName: path.basename(filename), response };
  });
  const selected = selectFactsOcrImages(ocrImages);
  if (selected.length === 0) {
    return {
      facts: null,
      imageIngredients: needsIngredientFallback ? await extractImageIngredients(options, product, ocrImages) : [],
    };
  }

  const verdictFile = path.join(options.jobDirectory, "amazon", "images", product.asin, "label.raw.json");
  const stored = await readJson<StoredRawLabelVerdict>(verdictFile);
  const prompt = `${buildOcrTextLabelPrompt(selected)}\nIMPORTANT: the runner wrapper overrides the earlier top-level output sentence. Return one object with one string field named payload, and put the requested JSON object serialized exactly inside payload.`;
  const verdict = await extractLabelJsonWithRepair({
    prompt,
    tag: `label-${product.asin}`,
    runModel: options.runModel,
    stored,
  });
  if (!stored || stored.raw !== verdict.raw || stored.parsed !== verdict.parsed) await writeJson(verdictFile, verdict);
  const label = verdict.parsed;
  if (label?.ambiguous) return { facts: null, imageIngredients: [], review: `${product.asin}: OCR 发现多张不同配方，不能合并` };
  if (label?.skip) return { facts: null, imageIngredients: [] };
  const parsed = parseLabel(label);
  if (!parsed) return { facts: null, imageIngredients: [], review: `${product.asin}: OCR 命中 Facts 结构，但语义解析未形成合法成分行` };

  return { imageIngredients: [], facts: {
    channel: "amazon",
    externalId: product.asin,
    sourceUrl: `${new URL(options.url).origin}/dp/${product.asin}`,
    capturedAt: product.capturedAt,
    source: `crawl-automation:${options.runId}:label_ocr`,
    confidence: scoreConfidence(label!, parsed),
    ...(product.extracted.images[selected[0]!.index] ? { sourceImageUrl: product.extracted.images[selected[0]!.index] } : {}),
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
  } };
}

function normalizeUnitsPeriod(value: string | undefined) {
  if (!value) return undefined;
  if (value === "month") return "trailing_30d" as const;
  return "unknown" as const;
}

export function verifiedAmazonBrand(extracted: Pick<ExtractedProduct, "brand" | "manufacturer" | "title">) {
  const direct = extracted.brand?.trim();
  if (direct) return direct;
  const manufacturer = extracted.manufacturer?.trim();
  const title = extracted.title?.trim();
  if (!manufacturer || !title) return null;
  const escaped = manufacturer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}(?:\\b|\\s|[-–—:])`, "i").test(title) ? manufacturer : null;
}

export function normalizeAmazonProduct(
  product: CapturedProduct,
  semantic: CleanResult,
  unified: ProductUnifyResult,
  facts: ProductFacts | null,
  imageIngredients: string[],
  domain: string,
  runId: string,
  sourceOrigin: string,
  crawlScope: "full" | "partial",
): NormalizedProduct {
  const factsIngredients = (facts?.rows ?? [])
    .filter((row) => row.isActive !== false)
    .map((row) => row.name.trim())
    .filter(Boolean);
  const ingredients = [...new Set([...semantic.ingredients, ...factsIngredients, ...imageIngredients])];
  const payload = toEnrichPayload({
    asin: product.asin,
    extracted: product.extracted,
    semantic: { ...semantic, ingredients },
    companyDomain: domain,
    capturedAt: new Date(product.capturedAt),
    source: `crawl-automation:${runId}`,
    crawlScope,
  });
  return normalizedProductSchema.parse({
    ...payload,
    productName: unified.productName,
    titleRaw: product.extracted.title ?? unified.productName,
    productUrl: `${sourceOrigin}/dp/${product.asin}`,
    sourceUrl: `${sourceOrigin}/dp/${product.asin}`,
    unitsSoldPeriod: normalizeUnitsPeriod(payload.unitsSoldPeriod),
    sku: null,
    skuMissing: true,
    ...(unified.baseName ? { baseName: unified.baseName } : {}),
    variant: unified.variant,
    variantConfidence: unified.variantConfidence,
    variantSource: unified.variantSource,
    attrsRaw: unified.attrsRaw,
    family: product.family.parentAsin || product.family.members.length > 1 ? {
      parentExternalId: product.family.parentAsin,
      label: product.familyLabel,
      evidence: "explicit",
    } : null,
    variantAttrs: {
      ...(payload.variantAttrs ?? {}),
      ...(product.familyLabel ? { label: product.familyLabel } : {}),
    },
  });
}


// v1 单体编排 runAmazonPipeline 已删除：Amazon 现在走 workers/capture-amazon.ts + v2/channels/amazon.ts
