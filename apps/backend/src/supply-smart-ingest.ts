import { createHash } from "node:crypto";
import { z } from "zod";

export const EnrichIngredientSchema = z.union([
  z.string().trim().min(1),
  z.object({
    name: z.string().trim().min(1),
    substance: z.string().trim().min(1).optional(),
    form: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
  }).refine((value) => !value.form || Boolean(value.substance), {
    message: "ingredient.form 必须同时提供 substance",
  }),
]);

export const normalizedProductSchema = z.object({
  domain: z.string().trim().min(1),
  productName: z.string().trim().min(1),
  productUrl: z.url(),
  channel: z.string().trim().toLowerCase().min(1),
  externalId: z.string().trim().min(1),
  sourceUrl: z.url(),
  capturedAt: z.iso.datetime(),
  crawlScope: z.enum(["full", "partial"]),
  source: z.string().trim().min(1),
  sku: z.string().trim().min(1).nullable(),
  skuMissing: z.boolean(),
  price: z.string().optional(),
  currency: z.string().optional(),
  listPrice: z.string().optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().nonnegative().optional(),
  salesRank: z.number().int().positive().optional(),
  inStock: z.boolean().optional(),
  unitsSold: z.number().int().nonnegative().optional(),
  unitsSoldPeriod: z.enum(["trailing_30d", "monthly", "lifetime", "unknown"]).optional(),
  images: z.array(z.url()),
  healthFunctions: z.array(z.string().trim().min(1)),
  mainIngredients: z.array(EnrichIngredientSchema).min(1),
  productForm: z.string().trim().min(1),
  nutritionScope: z.object({
    policy: z.literal("nutrition_single_products"),
    decision: z.literal("included"),
    evidence: z.array(z.string().trim().min(1)).min(1),
  }),
  variantAttrs: z.record(z.string(), z.unknown()).optional(),
  family: z.object({
    parentExternalId: z.string().min(1).nullable(),
    label: z.string().min(1).nullable(),
    evidence: z.literal("explicit"),
  }).nullable().optional(),
}).superRefine((value, context) => {
  if ((value.sku === null) !== value.skuMissing) {
    context.addIssue({ code: "custom", message: "sku 与 skuMissing 必须一致" });
  }
});

export const factsRowSchema = z.object({
  name: z.string().trim().min(1),
  amountValue: z.number().nonnegative().nullable().optional(),
  amountUnit: z.string().trim().nullable().optional(),
  dvPercent: z.number().nonnegative().nullable().optional(),
  position: z.number().int().nonnegative(),
  isActive: z.boolean().default(true),
  parentPosition: z.number().int().nonnegative().nullable().optional(),
});

export const productFactsSchema = z.object({
  channel: z.string().trim().toLowerCase().min(1),
  externalId: z.string().trim().min(1),
  sourceUrl: z.url(),
  capturedAt: z.iso.datetime(),
  source: z.string().trim().min(1),
  confidence: z.number().int().min(0).max(100),
  servingSize: z.number().positive().nullable().optional(),
  servingUnit: z.string().trim().nullable().optional(),
  servingsPerContainer: z.number().int().positive().nullable().optional(),
  netContent: z.string().trim().nullable().optional(),
  rows: z.array(factsRowSchema).min(1),
});

export const productBatchSchema = z.object({
  schemaVersion: z.literal("2.0"),
  products: z.array(normalizedProductSchema),
  facts: z.array(productFactsSchema).default([]),
});

export const processingResultSchema = z.object({
  status: z.enum(["complete", "needs_review", "failed"]),
  summary: z.string().min(1),
  reasonCode: z.string().nullable().optional(),
  batch: productBatchSchema,
});

export type NormalizedProduct = z.infer<typeof normalizedProductSchema>;
export type ProductFacts = z.infer<typeof productFactsSchema>;
export type ProductBatch = z.infer<typeof productBatchSchema>;

type RpcEnvelope<T> = { json: T } | T;

class NonRetryableRpcError extends Error {}

function unwrap<T>(value: RpcEnvelope<T>): T {
  if (value && typeof value === "object" && "json" in value) return (value as { json: T }).json;
  return value as T;
}

function errorMessage(payload: unknown, status: number) {
  if (payload && typeof payload === "object") {
    const value = payload as Record<string, any>;
    return value.error?.message ?? value.json?.message ?? value.message ?? `Jakarta HTTP ${status}`;
  }
  return `Jakarta HTTP ${status}`;
}

function normalizeDomain(value: string) {
  const trimmed = value.trim();
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return trimmed.toLowerCase().replace(/^www\./, "").split("/")[0]!;
  }
}

export class SupplySmartApi {
  constructor(private readonly options: { baseUrl: string; timeoutMs?: number; retries?: number; fetchImpl?: typeof fetch }) {}

  private async rpc<T>(route: string, input: unknown = {}) {
    const retries = this.options.retries ?? 2;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await (this.options.fetchImpl ?? fetch)(
          `${this.options.baseUrl.replace(/\/$/, "")}/rpc/${route}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ json: input }),
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
          },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = errorMessage(payload, response.status);
          if (response.status < 500 && response.status !== 429) throw new NonRetryableRpcError(message);
          const error = new Error(message);
          lastError = error;
        } else {
          return unwrap<T>(payload as RpcEnvelope<T>);
        }
      } catch (error) {
        if (error instanceof NonRetryableRpcError) throw error;
        lastError = error;
        if (attempt >= retries) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
    throw lastError;
  }

  async loadHealthFunctions() {
    const value = await this.rpc<unknown>("product/listAllHealthFunctions");
    return z.array(z.object({ name: z.string().min(1) })).parse(value).map((item) => item.name);
  }

  async resolveCompanyDomain(brand: string) {
    const exact = await this.rpc<unknown>("company/getByExactName", { exactname: brand }).catch(() => null);
    const parsed = z.object({ website: z.string().nullable() }).safeParse(exact);
    if (parsed.success && parsed.data.website) return normalizeDomain(parsed.data.website);

    const searched = await this.rpc<any>("company/search", { query: brand, limit: 20, page: 1 }).catch(() => null);
    const candidates = Array.isArray(searched?.data) ? searched.data : [];
    const brandKey = brand.toLowerCase().replace(/[^a-z0-9]/g, "");
    const exactCandidates = candidates.filter((company: any) =>
      typeof company?.name === "string" && company.name.toLowerCase().replace(/[^a-z0-9]/g, "") === brandKey,
    );
    const selected = exactCandidates.length === 1 ? exactCandidates[0] : candidates.length === 1 ? candidates[0] : null;
    if (typeof selected?.id === "string") {
      const company = await this.rpc<any>("company/getById", { id: selected.id }).catch(() => null);
      if (typeof company?.website === "string" && company.website.trim()) return normalizeDomain(company.website);
    }

    const listed = await this.rpc<any>("company/list", { page: 1, pageSize: 20, name: brand }).catch(() => null);
    const companies = Array.isArray(listed?.companies) ? listed.companies : Array.isArray(listed?.data) ? listed.data : [];
    const matches = companies.filter((company: any) =>
      typeof company?.name === "string" && company.name.toLowerCase().replace(/[^a-z0-9]/g, "") === brandKey && typeof company.website === "string",
    );
    return matches.length === 1 ? normalizeDomain(matches[0].website as string) : null;
  }

  private enrichPayload(product: NormalizedProduct) {
    const familyAttrs = product.family ? {
      familyParentExternalId: product.family.parentExternalId,
      familyLabel: product.family.label,
    } : {};
    return {
      domain: normalizeDomain(product.domain),
      productName: product.productName,
      productUrl: product.productUrl,
      channel: product.channel,
      externalId: product.externalId,
      sourceUrl: product.sourceUrl,
      capturedAt: product.capturedAt,
      crawlScope: product.crawlScope,
      source: product.source,
      price: product.price,
      currency: product.currency,
      listPrice: product.listPrice,
      rating: product.rating,
      reviewCount: product.reviewCount,
      salesRank: product.salesRank,
      inStock: product.inStock,
      unitsSold: product.unitsSold,
      unitsSoldPeriod: product.unitsSoldPeriod,
      images: product.images,
      healthFunctions: product.healthFunctions,
      mainIngredients: product.mainIngredients,
      productForm: product.productForm,
      titleRaw: product.productName,
      variantAttrs: { ...(product.variantAttrs ?? {}), ...familyAttrs, sku: product.sku, skuMissing: product.skuMissing },
      updateExisting: true,
      processedAt: new Date().toISOString(),
    };
  }

  async ingestAndValidate(rawBatch: unknown) {
    const batch = productBatchSchema.parse(rawBatch);
    const factsByListing = new Map(batch.facts.map((facts) => [`${facts.channel}:${facts.externalId}`, facts]));
    const verified: Array<{ channel: string; externalId: string; productId: string; matchedBy: string; factsHash: string | null }> = [];
    const problems: string[] = [];

    for (const product of batch.products) {
      try {
        const enriched = await this.rpc<any>("product/enrich", this.enrichPayload(product));
        if (!enriched?.productId) throw new Error("product/enrich 未返回 productId");
        if (!enriched.companyId) throw new Error(`公司域名未匹配：${product.domain}`);
        if (enriched.observationSkipped) throw new Error(`listing 观测被跳过：${enriched.observationSkipped}`);

        const facts = factsByListing.get(`${product.channel}:${product.externalId}`);
        let factsHash: string | null = null;
        if (facts) {
          const submitted = await this.rpc<any>("product/submitFacts", { ...facts, productId: enriched.productId });
          if (submitted?.decision !== "recorded" || !submitted?.factsHash) throw new Error("product/submitFacts 未确认记录");
          factsHash = submitted.factsHash;
        }

        const readback = await this.rpc<any>("product/getById", { id: enriched.productId });
        if (readback?.id !== enriched.productId) throw new Error("product/getById 回读 ID 不一致");
        verified.push({ channel: product.channel, externalId: product.externalId, productId: enriched.productId, matchedBy: enriched.matchedBy, factsHash });
      } catch (error) {
        problems.push(`${product.channel}:${product.externalId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    verified.sort((left, right) => `${left.channel}:${left.externalId}`.localeCompare(`${right.channel}:${right.externalId}`));
    return {
      loaded: verified.length,
      verified: verified.length,
      problems,
      records: verified,
      readbackHash: createHash("sha256").update(JSON.stringify(verified)).digest("hex"),
    };
  }
}
