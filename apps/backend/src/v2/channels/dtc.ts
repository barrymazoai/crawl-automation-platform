import fs from "node:fs/promises";
import path from "node:path";
import { chunk } from "../../amazon/semantic-clean.js";
import { buildOcrTextLabelPrompt, mapWithConcurrency, selectFactsOcrImages, type IndexedOcrImage } from "../../amazon/ocr-label-pipeline.js";
import { extractLabelJsonWithRepair, type StoredRawLabelVerdict } from "../../amazon/label-extraction.js";
import { parseLabel, scoreConfidence } from "../../amazon/label-parse.js";
import { buildGncBatchPrompt, parseGncBatchOutput, type GncCleanInput, type GncCleanResult } from "../../gnc/semantic.js";
import { normalizedProductSchema, type NormalizedProduct } from "../../supply-smart-ingest.js";
import { canonicalVariantForm, type ProductUnifyInput, type ProductVariant } from "../../product-unify.js";
import type { DtcRawProduct } from "../dtc-capture.js";
import { runRoot } from "../paths.js";
import type { ChannelFactsResult, ChannelHooks, StageContext } from "../stages.js";
import { buildBundleFileIndex } from "../dtc-capture.js";

const evidenceIndexCache = new Map<string, Promise<Map<string, string>>>();
/** 找本地图片：路径存在直接用；否则按文件名在本 run 的 evidence/ 下找（索引按 run 缓存）。 */
async function resolveEvidenceImage(ctx: StageContext, filename: string) {
  if (await fs.stat(filename).then(() => true).catch(() => false)) return filename;
  const evidenceRoot = path.join(ctx.workRoot, ctx.runId, "v2", "evidence");
  let index = evidenceIndexCache.get(evidenceRoot);
  if (!index) { index = buildBundleFileIndex(evidenceRoot); evidenceIndexCache.set(evidenceRoot, index); }
  const found = (await index).get(path.basename(filename));
  return found ?? null;
}

/**
 * DTC（独立站）的 ChannelHooks。
 *
 * 与 v1 的区别：v1 用一个大 Codex prompt 一次性做完语义 + Unify + Facts；
 * v2 拆成分阶段——语义走批量分类 prompt（与 GNC/Swanson 同一套词表），
 * Facts 走图片 OCR 阶梯。图片已由 Windows 端抓好放在证据包里，这里直接读本地文件。
 */

async function readJson<T>(filename: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(filename, "utf8")) as T; }
  catch { return null; }
}

async function writeJson(filename: string, value: unknown) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function safeKey(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function createDtcChannelHooks(): ChannelHooks<DtcRawProduct, GncCleanResult, ChannelFactsResult> {
  const domainCache = new Map<string, string | null>();
  return {
    channel: "dtc",
    key: (product) => product.externalId,
    describe: (product) => ({ title: product.title, productUrl: product.productUrl }),

    async clean(ctx, products, tagPrefix) {
      const vocabulary = await ctx.supplySmart.loadHealthFunctions();
      const inputs: GncCleanInput[] = products.map((product) => ({
        sku: product.externalId,
        title: product.title,
        description: product.description,
        details: [product.detailText, Object.entries(product.variantOptions).map(([key, value]) => `${key}: ${value}`).join(" | ")]
          .filter(Boolean).join("\n"),
        labelText: null,
        labelIngredients: [],
      }));
      const outcomes = await mapWithConcurrency(chunk(inputs, 50), 2, async (batch, index) => {
        const prompt = `${buildGncBatchPrompt(batch, vocabulary)}\nIMPORTANT: Return one object with one string field named payload, and serialize the requested JSON array exactly inside payload.`;
        return parseGncBatchOutput(await ctx.runModel({ prompt, tag: `${tagPrefix}-${index}` }), batch, vocabulary);
      });
      return { results: outcomes.flatMap((item) => item.results), warnings: outcomes.flatMap((item) => item.problems) };
    },
    semanticKey: (semantic) => semantic.sku,
    included: (semantic) => semantic.scopeDecision === "included",

    // 独立站没有统一的 HTML 成分表结构：Facts 证据一律来自画廊图片。
    htmlFactsReady: () => false,

    async extractFacts(ctx: StageContext, product) {
      if (product.localImages.length === 0) return { facts: null };
      const workDirectory = path.join(runRoot(ctx.workRoot, ctx.runId), "labels", safeKey(product.externalId));
      // 证据包里的相对路径可能写错（Codex 拼的包），按文件名在 run 的证据目录里找回来；找不到的跳过而不是整批失败
      const resolved = (await Promise.all(product.localImages.map((filename) => resolveEvidenceImage(ctx, filename)))).filter((f): f is string => Boolean(f));
      if (resolved.length === 0) return { facts: null };
      const ocrImages = await mapWithConcurrency(resolved, 1, async (filename, index): Promise<IndexedOcrImage> => {
        const cache = `${filename}.ocr.json`;
        let response = await readJson<any>(cache);
        if (!response) { response = await ctx.ocr.recognize(filename); await writeJson(cache, response); }
        return { index, fileName: path.basename(filename), response };
      });
      const selected = selectFactsOcrImages(ocrImages);
      if (selected.length === 0) return { facts: null };

      const verdictFile = path.join(workDirectory, "label.raw.json");
      const stored = await readJson<StoredRawLabelVerdict>(verdictFile);
      const prompt = `${buildOcrTextLabelPrompt(selected)}\nIMPORTANT: Return one object with one string field named payload, and put the requested JSON object serialized exactly inside payload.`;
      const verdict = await extractLabelJsonWithRepair({ prompt, tag: `dtc-label-${safeKey(product.externalId)}`, runModel: ctx.runModel, stored });
      if (!stored || stored.raw !== verdict.raw || stored.parsed !== verdict.parsed) await writeJson(verdictFile, verdict);
      const label = verdict.parsed;
      if (label?.ambiguous) return { facts: null, review: `${product.externalId}: OCR 发现多张不同配方，不能合并` };
      if (label?.skip) return { facts: null };
      const parsed = parseLabel(label);
      if (!parsed) return { facts: null, review: `${product.externalId}: OCR 命中 Facts 结构，但语义解析未形成合法成分行` };
      return {
        facts: {
          channel: "dtc",
          externalId: product.externalId,
          sourceUrl: product.productUrl,
          capturedAt: product.capturedAt,
          source: `crawl-automation:${ctx.runId}:label_ocr`,
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
        },
      };
    },

    unifyInput(product, semantic): ProductUnifyInput | null {
      if (!product.title.trim()) return null;
      const structuredVariant: ProductVariant = {};
      for (const [key, value] of Object.entries(product.variantOptions)) {
        const lower = key.toLowerCase();
        if (/flavou?r/.test(lower)) structuredVariant.flavor = value;
        else if (/size|count|pack|case/.test(lower)) structuredVariant.size = value;
        else if (/form/.test(lower)) { const form = canonicalVariantForm(value); if (form) structuredVariant.form = form; }
      }
      const form = canonicalVariantForm(semantic.productForm);
      if (!structuredVariant.form && form) structuredVariant.form = form;
      return {
        clientRef: product.externalId,
        channel: "dtc",
        titleRaw: product.title,
        brand: null,
        structuredVariant,
        attrsRaw: product.variantOptions,
        productFormHint: semantic.productForm === "other" ? null : semantic.productForm,
      };
    },

    async resolveDomain(ctx, product) {
      // 独立站的品牌域名就是站点自身域名；仍与产品库核对一次，取库里的规范写法。
      if (!domainCache.has(product.domain)) {
        const resolved = await ctx.supplySmart.resolveCompanyDomain(product.domain).catch(() => null);
        domainCache.set(product.domain, resolved ?? product.domain);
      }
      return domainCache.get(product.domain) ?? product.domain;
    },

    normalize: (ctx, input): NormalizedProduct => normalizedProductSchema.parse({
      domain: input.domain,
      productName: input.unified.productName,
      titleRaw: input.product.title,
      productUrl: input.product.productUrl,
      channel: "dtc",
      externalId: input.product.externalId,
      sourceUrl: input.product.productUrl,
      capturedAt: input.product.capturedAt,
      crawlScope: input.scope,
      source: `crawl-automation:${ctx.runId}`,
      sku: input.product.sku,
      skuMissing: input.product.sku == null,
      ...(input.product.price ? { price: input.product.price } : {}),
      ...(input.product.currency ? { currency: input.product.currency } : {}),
      ...(input.product.available != null ? { inStock: input.product.available } : {}),
      images: input.product.images,
      healthFunctions: input.semantic.healthFunctions,
      mainIngredients: input.semantic.ingredients,
      productForm: input.semantic.productForm,
      nutritionScope: { policy: "nutrition_single_products", decision: "included", evidence: input.semantic.scopeEvidence },
      ...(input.unified.baseName ? { baseName: input.unified.baseName } : {}),
      variant: input.unified.variant,
      variantConfidence: input.unified.variantConfidence,
      variantSource: input.unified.variantSource,
      attrsRaw: input.unified.attrsRaw,
      variantAttrs: input.product.variantOptions,
      family: null,
    }),
  };
}
