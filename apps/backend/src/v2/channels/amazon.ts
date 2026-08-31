import { chunk } from "../../amazon/semantic-clean.js";
import { mapWithConcurrency } from "../../amazon/ocr-label-pipeline.js";
import { buildBatchPrompt, parseBatchOutput, type CleanInput, type CleanResult } from "../../amazon/semantic-clean.js";
import {
  amazonUnifyInput,
  extractFacts as extractAmazonFacts,
  normalizeAmazonProduct,
  verifiedAmazonBrand,
  type AmazonPipelineOptions,
} from "../../amazon/pipeline.js";
import { canonicalVariantStrength, type ProductVariant } from "../../product-unify.js";
import type { AmazonRawProduct } from "../amazon-capture.js";
import { runRoot } from "../paths.js";
import type { ChannelFactsResult, ChannelHooks, StageContext } from "../stages.js";

/** Amazon 的 Facts 结果比通用契约多一份 image-ingredient 兜底证据。 */
export type AmazonFactsResult = ChannelFactsResult & { imageIngredients: string[] };

/** 复用 v1 的 extractFacts 阶梯：所有下载/OCR/verdict 缓存落在 v2 run 根目录下，跨 stage job 复用。 */
function factsOptions(ctx: StageContext): AmazonPipelineOptions {
  return {
    url: ctx.sourceUrl,
    runId: ctx.runId,
    jobDirectory: runRoot(ctx.workRoot, ctx.runId),
    maxItems: 0,
    // 产品级已由编排层并行，产品内下载/OCR 串行，总并发不超过 OCR_IMAGE_CONCURRENCY。
    ocrConcurrency: 1,
    signal: ctx.signal,
    ocr: ctx.ocr,
    supplySmart: ctx.supplySmart,
    productWriter: ctx.productWriter,
    runModel: ctx.runModel,
  };
}

function toFactsResult(result: { facts: AmazonFactsResult["facts"]; imageIngredients: string[]; review?: string }): AmazonFactsResult {
  return { facts: result.facts, ...(result.review ? { review: result.review } : {}), imageIngredients: result.imageIngredients };
}

export function createAmazonChannelHooks(): ChannelHooks<AmazonRawProduct, CleanResult, AmazonFactsResult> {
  const domainCache = new Map<string, string | null>();
  return {
    channel: "amazon",
    key: (product) => product.asin,
    describe: (product) => ({
      title: product.extracted.title ?? product.asin,
      productUrl: `${product.sourceOrigin}/dp/${product.asin}`,
    }),

    async clean(ctx, products, tagPrefix) {
      const vocabulary = await ctx.supplySmart.loadHealthFunctions();
      const inputs: CleanInput[] = products.map((product) => ({
        asin: product.asin,
        title: product.extracted.title,
        formField: product.extracted.itemForm,
        bullets: product.extracted.bullets,
        description: product.extracted.description,
        aplusText: product.extracted.aplusText,
        ingredientsRaw: product.extracted.ingredientsText,
      }));
      const outcomes = await mapWithConcurrency(chunk(inputs, 50), 2, async (batch, index) => {
        const prompt = `${buildBatchPrompt(batch, vocabulary)}\nIMPORTANT: the runner wrapper overrides the earlier top-level output sentence. Return one object with one string field named payload, and put the requested JSON array serialized exactly inside payload.`;
        const payload = await ctx.runModel({ prompt, tag: `${tagPrefix}-${index}` });
        return parseBatchOutput(payload, batch, vocabulary);
      });
      return { results: outcomes.flatMap((item) => item.results), warnings: outcomes.flatMap((item) => item.problems) };
    },
    semanticKey: (semantic) => semantic.asin,
    included: (semantic) => semantic.scopeDecision === "included",

    // Amazon 没有 HTML Facts 表：所有 Facts 证据都在标签图片里，统一走图片线。
    htmlFactsReady: () => false,
    extractFacts: async (ctx, product) => toFactsResult(await extractAmazonFacts(factsOptions(ctx), product, false)),

    /**
     * Join 兜底（对应 v1 的 needsIngredientFallback）：语义没找到成分、标签也没形成 Facts 时，
     * 用缓存的 OCR 文本跑一次 ingredient 提取。下载/OCR/verdict 全部命中缓存，只新增一次模型调用。
     */
    async augmentFacts(ctx, product, semantic, facts) {
      if (!semantic || semantic.ingredients.length > 0) return null;
      const current = facts as AmazonFactsResult | null;
      if (current?.facts || (current?.imageIngredients?.length ?? 0) > 0) return null;
      if (product.extracted.images.length === 0) return null;
      return toFactsResult(await extractAmazonFacts(factsOptions(ctx), product, true));
    },

    unifyInput: (product, semantic) => amazonUnifyInput(product, semantic),
    unifyBatchSize: 20,
    mapUnifyResult: (result) => ({
      ...result,
      variant: {
        ...result.variant,
        ...(result.variant.strength !== undefined
          ? { strength: canonicalVariantStrength(result.variant.strength) as ProductVariant["strength"] }
          : {}),
      },
    }),

    validate(product, semantic, facts) {
      const current = facts as AmazonFactsResult | null;
      const hasFormulaEvidence = semantic.ingredients.length > 0
        || (current?.imageIngredients?.length ?? 0) > 0
        || Boolean(current?.facts?.rows.some((row) => row.isActive !== false && row.name.trim()));
      return hasFormulaEvidence ? [] : [`${product.asin}: 页面文字和标签图片都没有形成可验证的配方成分`];
    },

    async resolveDomain(ctx, product) {
      const brand = verifiedAmazonBrand(product.extracted);
      if (!brand) return null;
      if (!domainCache.has(brand)) domainCache.set(brand, await ctx.supplySmart.resolveCompanyDomain(brand));
      return domainCache.get(brand) ?? null;
    },

    normalize: (ctx, input) => {
      const current = input.facts as AmazonFactsResult | null;
      return normalizeAmazonProduct(
        input.product,
        input.semantic,
        input.unified,
        current?.facts ?? null,
        current?.imageIngredients ?? [],
        input.domain,
        ctx.runId,
        input.product.sourceOrigin,
        input.scope,
      );
    },
  };
}
