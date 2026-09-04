import fs from "node:fs/promises";
import path from "node:path";
import { chunk } from "../../amazon/semantic-clean.js";
import { buildHtmlFactsTablePrompt, buildOcrTextLabelPrompt, mapWithConcurrency, selectFactsOcrImages, type IndexedOcrImage } from "../../amazon/ocr-label-pipeline.js";
import { hasCompleteFactsText } from "../../gnc/facts.js";
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
    // 独立站的"品牌"就是站点本身，公司认领时按域名对
    brand: (product) => product.domain || null,
    sidelineFields: (product) => ({ sku: product.sku ?? null, price: product.price ?? null, capturedAt: product.capturedAt }),

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

    /*
     * 独立站的成分表要么在页面 HTML、要么在画廊图里，后者要等 OCR。而语义阶段跑在图片线之前，
     * 那时 LABEL_TEXT 必然是空的，模型只能判 ingredients_and_formula_missing——liveowyn 121 个
     * 变体就是这样全军覆没的，其实 OCR 后有 49 个成功解析出了完整营养成分表。
     * 所以到 join（证据已到齐）再修订：仅当排除理由正是"没有配方证据"、而成分表确实拿到了才翻案；
     * 非营养品、套装等与证据无关的排除理由一律保持不动。
     */
    reviseScope: (semantic, facts) => {
      if (semantic.scopeDecision !== "excluded") return semantic;
      if (semantic.scopeReason !== "ingredients_and_formula_missing" && semantic.scopeReason !== "nutrition_evidence_missing") return semantic;
      const rows = facts?.facts?.rows ?? [];
      if (rows.length < 2) return semantic;
      // 语义那一遍没读到成分时 ingredients 是空的；入库要求至少一条，这里按成分表的活性行补上，
      // 补不出来就维持排除——放进去只会在 catalog_finalize 触发 schema 报错，把整个 run 拖垮。
      const ingredients = semantic.ingredients.length > 0
        ? semantic.ingredients
        : [...new Set(rows.filter((row) => row.isActive !== false).map((row) => row.name.trim()).filter(Boolean))];
      if (ingredients.length === 0) return semantic;
      return {
        ...semantic,
        ingredients,
        scopeDecision: "included" as const,
        scopeReason: "nutrition_product" as const,
        scopeEvidence: [`成分表已从图片/页面提取到 ${rows.length} 行，原排除理由（缺配方证据）不成立`, ...semantic.scopeEvidence].slice(0, 5),
      };
    },

    /*
     * 独立站的成分表在哪不能预设——分层"看一眼再决定"：
     *   1. 页面 HTML 里有完整成分表 → 文字线直接解析，不 OCR（htmlFactsReady）
     *   2. 页面指认了成分表图片（alt/src 含 supplement/nutrition facts/label）→ 先只 OCR 这些
     *   3. 都没有 → 画廊逐张 OCR
     */
    htmlFactsReady: (product) => hasCompleteFactsText((product.htmlFactsText ?? "").trim()),

    async extractFacts(ctx: StageContext, product) {
      const workDirectory = path.join(runRoot(ctx.workRoot, ctx.runId), "labels", safeKey(product.externalId));
      const verdictFile = path.join(workDirectory, "label.raw.json");
      const stored = await readJson<StoredRawLabelVerdict>(verdictFile);
      const htmlFactsText = (product.htmlFactsText ?? "").trim();
      let prompt: string; let method: "label_html" | "label_ocr"; let sourceImageUrl: string | undefined;

      if (hasCompleteFactsText(htmlFactsText)) {
        // 第 1 层：页面成分表
        method = "label_html";
        prompt = `${buildHtmlFactsTablePrompt(htmlFactsText)}\nIMPORTANT: Return one object with one string field named payload, and put the requested JSON object serialized exactly inside payload.`;
      } else {
        if (product.localImages.length === 0) return { facts: null };
        // 证据包里的相对路径可能写错（Codex 拼的包），按文件名在 run 的证据目录里找回来；找不到的跳过而不是整批失败
        const resolvedAll = (await Promise.all(product.localImages.map(async (filename, i) => ({ i, file: await resolveEvidenceImage(ctx, filename) }))))
          .filter((x): x is { i: number; file: string } => Boolean(x.file));
        if (resolvedAll.length === 0) return { facts: null };
        // 第 2 层：页面指认的成分表图排最前；只有它们没读出 Facts 才轮到第 3 层全画廊
        const hinted = new Set(product.factsImageUrls);
        const ordered = [...resolvedAll].sort((a, b) => Number(hinted.has(product.images[b.i] ?? "")) - Number(hinted.has(product.images[a.i] ?? "")));
        const hintedCount = ordered.filter((x) => hinted.has(product.images[x.i] ?? "")).length;
        // 单张图 OCR 失败（画廊里混进 OCR 服务解不了的格式，实测有 .jpg 其实是 AVIF）只跳过这一张，
        // 不能让整批 10 个产品跟着失败。
        const ocr = async (subset: typeof ordered) => {
          const results = await mapWithConcurrency(subset, 1, async ({ i, file }): Promise<IndexedOcrImage | null> => {
            const cache = `${file}.ocr.json`;
            let response = await readJson<any>(cache);
            if (!response) {
              try {
                response = await ctx.ocr.recognize(file);
              } catch (error) {
                console.log(JSON.stringify({ type: "dtc_ocr_image_skipped", file: path.basename(file), reason: error instanceof Error ? error.message : String(error) }));
                return null;
              }
              await writeJson(cache, response);
            }
            return { index: i, fileName: path.basename(file), response };
          });
          return results.filter((item): item is IndexedOcrImage => item !== null);
        };
        let selected = hintedCount > 0 ? selectFactsOcrImages(await ocr(ordered.slice(0, hintedCount))) : [];
        if (selected.length === 0) selected = selectFactsOcrImages(await ocr(ordered));
        if (selected.length === 0) return { facts: null };
        method = "label_ocr";
        sourceImageUrl = product.images[selected[0]!.index];
        prompt = `${buildOcrTextLabelPrompt(selected)}\nIMPORTANT: Return one object with one string field named payload, and put the requested JSON object serialized exactly inside payload.`;
      }
      const verdict = await extractLabelJsonWithRepair({ prompt, tag: `dtc-label-${safeKey(product.externalId)}`, runModel: ctx.runModel, stored });
      if (!stored || stored.raw !== verdict.raw || stored.parsed !== verdict.parsed) await writeJson(verdictFile, verdict);
      const label = verdict.parsed;
      if (label?.ambiguous) return { facts: null, review: `${product.externalId}: ${method === "label_html" ? "页面成分表" : "OCR"}发现多张不同配方，不能合并` };
      if (label?.skip) return { facts: null };
      const parsed = parseLabel(label);
      if (!parsed) return { facts: null, review: `${product.externalId}: ${method === "label_html" ? "页面成分表" : "OCR"}命中 Facts 结构，但语义解析未形成合法成分行` };
      return {
        facts: {
          channel: "dtc",
          externalId: product.externalId,
          sourceUrl: product.productUrl,
          capturedAt: product.capturedAt,
          source: `crawl-automation:${ctx.runId}:${method}`,
          confidence: scoreConfidence(label!, parsed),
          ...(sourceImageUrl ? { sourceImageUrl } : {}),
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
