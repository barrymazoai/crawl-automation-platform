import path from "node:path";
import { chunk } from "../../amazon/semantic-clean.js";
import { mapWithConcurrency } from "../../amazon/ocr-label-pipeline.js";
import { buildGncBatchPrompt, parseGncBatchOutput, type GncCleanInput, type GncCleanResult } from "../../gnc/semantic.js";
import {
  extractFacts as extractSwansonFacts,
  normalizeProduct,
  stripHtml,
  unifyInput,
  type CapturedSwansonProduct,
} from "../../swanson/pipeline.js";
import { runRoot } from "../paths.js";
import type { ChannelFactsResult, ChannelHooks, StageContext } from "../stages.js";

/** Swanson 的 Facts 结果比通用契约多一份标签文本与成分，供语义线复用。 */
export type SwansonFactsResult = ChannelFactsResult & { labelText: string | null; ingredients: string[] };

/**
 * Swanson 的 ChannelHooks：语义 prompt 与 GNC 共用（同一套营养品分类词表），
 * Facts 走图片 OCR 阶梯（Swanson 页面没有 HTML 成分表）。
 */
export function createSwansonChannelHooks(): ChannelHooks<CapturedSwansonProduct, GncCleanResult, SwansonFactsResult> {
  const domainCache = new Map<string, string | null>();
  return {
    channel: "swanson",
    key: (product) => product.externalId,
    describe: (product) => ({ title: product.product.title, productUrl: product.productUrl }),

    async clean(ctx, products, tagPrefix) {
      const vocabulary = await ctx.supplySmart.loadHealthFunctions();
      const inputs: GncCleanInput[] = products.map((product) => ({
        sku: product.externalId,
        title: product.product.title,
        description: stripHtml(product.product.description),
        details: [product.catalog.data.main_ingred, product.catalog.data.potent, product.catalog.data.pfdesc].filter(Boolean).join("\n"),
        // 文字线不等图片线：标签文本留空，成分证据由图片线在 Join 时补齐。
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

    // Swanson 商品页没有 HTML 成分表：所有 Facts 证据都在图片里，统一走图片线。
    htmlFactsReady: () => false,
    extractFacts: async (ctx: StageContext, product) => {
      const result = await extractSwansonFacts({
        jobDirectory: runRoot(ctx.workRoot, ctx.runId),
        runId: ctx.runId,
        // 产品级已由编排层并行，产品内 OCR 串行。
        ocrConcurrency: 1,
        ocr: ctx.ocr,
        runModel: ctx.runModel,
      }, product);
      return {
        facts: result.facts,
        ...(result.review ? { review: result.review } : {}),
        labelText: result.labelText,
        ingredients: result.ingredients,
      };
    },

    unifyInput: (product, semantic) => unifyInput(product, semantic),

    async resolveDomain(ctx, product) {
      const brand = product.catalog.brand;
      if (!domainCache.has(brand)) {
        const resolved = await ctx.supplySmart.resolveCompanyDomain(brand);
        domainCache.set(brand, resolved ?? (/^Swanson(?: Vitamins)?$/i.test(brand) ? "swansonvitamins.com" : null));
      }
      return domainCache.get(brand) ?? null;
    },

    normalize: (ctx, input) => normalizeProduct(input.product, input.semantic, input.unified, input.domain, ctx.runId, input.scope),
  };
}
