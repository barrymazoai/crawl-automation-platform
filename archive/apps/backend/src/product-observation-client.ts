import { createHash } from "node:crypto";
import { z } from "zod";
import {
  factsRowSchema,
  parsePriceString,
  productBatchSchema,
  type NormalizedProduct,
  type ProductBatch,
  type ProductFacts,
} from "./supply-smart-ingest.js";
import { productVariantSchema } from "./product-unify.js";

const MARKETPLACE_CHANNELS = new Set([
  "amazon", "gnc", "iherb", "walmart", "costco", "target", "cvs", "vitacost",
  "swanson", "wholefoods", "chewy", "tiktok",
]);

const ingredientSchema = z.union([
  z.string().trim().min(1),
  z.object({
    name: z.string().trim().min(1),
    substance: z.string().trim().min(1).optional(),
    form: z.string().trim().min(1).optional(),
    category: z.string().trim().min(1).optional(),
  }),
]);

const observationImageSchema = z.strictObject({
  clientRef: z.string().trim().min(1).max(200),
  url: z.string().trim().min(1),
  role: z.string().trim().min(1).optional(),
});

const observationFactsSchema = z.object({
  sourceImageRef: z.string().trim().min(1).optional(),
  capturedAt: z.iso.datetime().optional(),
  source: z.string().trim().min(1).optional(),
  confidence: z.number().int().min(0).max(100),
  servingSize: z.number().positive().nullable().optional(),
  servingUnit: z.string().trim().nullable().optional(),
  servingsPerContainer: z.number().int().positive().nullable().optional(),
  netContent: z.string().trim().nullable().optional(),
  rows: z.array(factsRowSchema).min(1),
});

export const observationItemSchema = z.object({
  clientRef: z.string().trim().min(1).max(200),
  domain: z.string().trim().min(1).optional(),
  productName: z.string().trim().min(1),
  productUrl: z.string().trim().min(1).optional(),
  titleRaw: z.string().trim().min(1).optional(),
  externalId: z.string().trim().min(1).optional(),
  sourceUrl: z.string().trim().min(1).optional(),
  siteKey: z.string().trim().min(1).optional(),
  capturedAt: z.iso.datetime(),
  price: z.string().optional(),
  currency: z.string().trim().min(1).optional(),
  listPrice: z.string().optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().nonnegative().optional(),
  salesRank: z.number().int().positive().optional(),
  inStock: z.boolean().optional(),
  unitsSold: z.number().int().nonnegative().optional(),
  unitsSoldPeriod: z.enum(["trailing_30d", "monthly", "lifetime", "unknown"]).optional(),
  extras: z.record(z.string(), z.unknown()).optional(),
  listedAt: z.iso.datetime().optional(),
  listedAtSource: z.string().trim().min(1).optional(),
  productForm: z.string().trim().min(1).optional(),
  healthFunctions: z.array(z.string().trim().min(1)).optional(),
  mainIngredients: z.array(ingredientSchema).optional(),
  gtin: z.string().regex(/^\d{8}$|^\d{12,14}$/).optional(),
  baseName: z.string().trim().min(1).optional(),
  variant: productVariantSchema.optional(),
  variantConfidence: z.number().int().min(0).max(100).optional(),
  variantSource: z.enum(["ai_extract", "channel_attrs", "manual"]).optional(),
  attrsRaw: z.record(z.string(), z.unknown()).optional(),
  images: z.array(observationImageSchema).default([]),
  facts: observationFactsSchema.optional(),
}).superRefine((value, context) => {
  if (!value.externalId && !value.sourceUrl) {
    context.addIssue({ code: "custom", message: "externalId/sourceUrl 至少提供一个" });
  }
});

export const observationRunSchema = z.object({
  runId: z.string().trim().min(1).max(200),
  channel: z.string().trim().toLowerCase().min(1),
  scope: z.enum(["full", "partial"]),
  siteKey: z.string().trim().min(1).optional(),
  companyDomain: z.string().trim().min(1).optional(),
  startedAt: z.iso.datetime(),
  source: z.string().trim().min(1),
}).superRefine((value, context) => {
  if (value.channel === "database" || value.channel === "unknown") {
    context.addIssue({ code: "custom", path: ["channel"], message: "channel 必须是真实销售渠道" });
  }
  if (value.scope === "full" && !value.siteKey && !value.companyDomain) {
    context.addIssue({ code: "custom", message: "full scope 必须带 siteKey 或 companyDomain" });
  }
});

export const observationBatchInputSchema = z.object({
  run: observationRunSchema,
  items: z.array(observationItemSchema).min(1).max(200),
});

const ingestResultSchema = z.object({
  clientRef: z.string(),
  status: z.enum(["ok", "failed"]),
  productId: z.string().nullable(),
  listingId: z.string().nullable(),
  matchedBy: z.string().nullable(),
  identity: z.object({ state: z.string(), variantKey: z.string().nullable().optional() }).passthrough().nullable(),
  facts: z.object({ factsHash: z.string() }).passthrough().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
}).passthrough();

const ingestOutputSchema = z.object({
  runId: z.string(),
  crawlRunId: z.string(),
  counts: z.object({
    received: z.number(), ok: z.number(), failed: z.number(), created: z.number(), matched: z.number(), needsReview: z.number(),
  }),
  results: z.array(ingestResultSchema),
});

const verifyOutputSchema = z.object({
  runId: z.string(),
  found: z.boolean(),
  verified: z.number(),
  expected: z.number(),
  items: z.array(z.object({
    clientRef: z.string(),
    problems: z.array(z.string()),
    mismatches: z.array(z.object({ field: z.string(), expected: z.unknown(), actual: z.unknown() })),
  }).passthrough()),
  problems: z.array(z.string()),
  readbackHash: z.string(),
}).passthrough();

const completeOutputSchema = z.object({
  runId: z.string(),
  found: z.boolean(),
  replayed: z.boolean(),
  scope: z.enum(["full", "partial"]).nullable(),
  status: z.string().nullable(),
  deactivated: z.number(),
  deactivatedListingIds: z.array(z.string()),
  problems: z.array(z.string()),
});

export type ObservationItem = z.infer<typeof observationItemSchema>;
export type ObservationRun = z.infer<typeof observationRunSchema>;

function normalizeDomain(value: string) {
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return value.trim().toLowerCase().replace(/^www\./, "").split("/")[0]!;
  }
}

function stableClientRef(channel: string, externalId: string) {
  const raw = `${channel}:${externalId}`;
  if (raw.length <= 200) return raw;
  return `${raw.slice(0, 130)}:${createHash("sha256").update(raw).digest("hex")}`;
}

function isGncProductDetail(sourceUrl: string) {
  try { return /\/\d{6}\.html$/i.test(new URL(sourceUrl).pathname); }
  catch { return false; }
}

function toImages(product: NormalizedProduct, facts: ProductFacts | undefined) {
  const urls = [...new Set(product.images)];
  if (facts?.sourceImageUrl && !urls.includes(facts.sourceImageUrl)) urls.push(facts.sourceImageUrl);
  const images = urls.map((url, index) => ({
    clientRef: `image-${String(index + 1).padStart(3, "0")}`,
    url,
    role: facts?.sourceImageUrl === url ? "facts" : "gallery",
  }));
  const sourceImageRef = facts?.sourceImageUrl
    ? images.find((image) => image.url === facts.sourceImageUrl)?.clientRef
    : undefined;
  return { images, sourceImageRef };
}

function toFacts(facts: ProductFacts | undefined, sourceImageRef: string | undefined) {
  if (!facts) return undefined;
  return observationFactsSchema.parse({
    ...(sourceImageRef ? { sourceImageRef } : {}),
    capturedAt: facts.capturedAt,
    source: facts.source,
    confidence: facts.confidence,
    ...(facts.servingSize !== undefined ? { servingSize: facts.servingSize } : {}),
    ...(facts.servingUnit !== undefined ? { servingUnit: facts.servingUnit } : {}),
    ...(facts.servingsPerContainer !== undefined ? { servingsPerContainer: facts.servingsPerContainer } : {}),
    ...(facts.netContent !== undefined ? { netContent: facts.netContent } : {}),
    rows: facts.rows,
  });
}

function itemExtras(product: NormalizedProduct) {
  const category = product.variantAttrs?.category;
  const extras = {
    ...(product.extras ?? {}),
    ...(typeof category === "string" && category.trim() ? { category: category.trim() } : {}),
  };
  return Object.keys(extras).length > 0 ? extras : undefined;
}

function itemAttrsRaw(product: NormalizedProduct) {
  const { category: _category, ...rawAttrs } = { ...(product.variantAttrs ?? {}), ...(product.attrsRaw ?? {}) };
  return {
    ...rawAttrs,
    ...(product.sku ? { sku: product.sku } : {}),
    skuMissing: product.skuMissing,
    ...(product.family ? {
      familyParentExternalId: product.family.parentExternalId,
      familyLabel: product.family.label,
      ...(product.family.name ? { familyName: product.family.name } : {}),
    } : {}),
  };
}

export function buildObservationPayload(rawBatch: unknown, input: { runId: string; sourceUrl: string }) {
  const batch = productBatchSchema.parse(rawBatch);
  if (batch.products.length === 0) throw new Error("没有可提交的产品观测");
  const channels = [...new Set(batch.products.map((product) => product.channel))];
  if (channels.length !== 1) throw new Error(`一个 crawl run 只能提交一个 channel，实际为 ${channels.join(",")}`);
  const channel = channels[0]!;
  const domains = [...new Set(batch.products.map((product) => normalizeDomain(product.domain)))];
  const allFull = batch.products.every((product) => product.crawlScope === "full");
  let scope: "full" | "partial" = allFull ? "full" : "partial";
  if (channel === "gnc" && isGncProductDetail(input.sourceUrl)) scope = "partial";
  if (scope === "full" && MARKETPLACE_CHANNELS.has(channel) && domains.length !== 1) scope = "partial";
  const siteKey = MARKETPLACE_CHANNELS.has(channel) ? undefined : normalizeDomain(input.sourceUrl);
  const companyDomain = domains.length === 1 ? domains[0] : undefined;
  const startedAt = batch.products.map((product) => product.capturedAt).sort()[0]!;
  const factsByProduct = new Map(batch.facts.map((facts) => [`${facts.channel}:${facts.externalId}`, facts]));
  const items = batch.products.map((product) => {
    const facts = factsByProduct.get(`${product.channel}:${product.externalId}`);
    const { images, sourceImageRef } = toImages(product, facts);
    return observationItemSchema.parse({
      clientRef: stableClientRef(product.channel, product.externalId),
      domain: normalizeDomain(product.domain),
      productName: product.productName,
      productUrl: product.productUrl,
      ...(product.titleRaw ? { titleRaw: product.titleRaw } : {}),
      externalId: product.externalId,
      sourceUrl: product.sourceUrl,
      capturedAt: product.capturedAt,
      ...(product.price !== undefined ? { price: product.price } : {}),
      ...(product.currency !== undefined ? { currency: product.currency } : {}),
      ...(product.listPrice !== undefined ? { listPrice: product.listPrice } : {}),
      ...(product.rating !== undefined ? { rating: product.rating } : {}),
      ...(product.reviewCount !== undefined ? { reviewCount: product.reviewCount } : {}),
      ...(product.salesRank !== undefined ? { salesRank: product.salesRank } : {}),
      ...(product.inStock !== undefined ? { inStock: product.inStock } : {}),
      ...(product.unitsSold !== undefined ? { unitsSold: product.unitsSold } : {}),
      ...(product.unitsSoldPeriod !== undefined ? { unitsSoldPeriod: product.unitsSoldPeriod } : {}),
      ...(itemExtras(product) ? { extras: itemExtras(product) } : {}),
      ...(product.listedAt ? { listedAt: product.listedAt } : {}),
      ...(product.listedAtSource ? { listedAtSource: product.listedAtSource } : {}),
      ...(product.productForm.toLowerCase() !== "other" ? { productForm: product.productForm } : {}),
      healthFunctions: product.healthFunctions,
      mainIngredients: product.mainIngredients,
      ...(product.gtin ? { gtin: product.gtin } : {}),
      ...(product.baseName ? { baseName: product.baseName } : {}),
      ...(product.variant ? { variant: product.variant } : {}),
      ...(product.variantConfidence !== undefined ? { variantConfidence: product.variantConfidence } : {}),
      ...(product.variantSource ? { variantSource: product.variantSource } : {}),
      attrsRaw: itemAttrsRaw(product),
      images,
      ...(facts ? { facts: toFacts(facts, sourceImageRef) } : {}),
    });
  });
  const run = observationRunSchema.parse({
    runId: input.runId,
    channel,
    scope,
    ...(siteKey ? { siteKey } : {}),
    ...(companyDomain ? { companyDomain } : {}),
    startedAt,
    source: `crawl-automation:${input.runId}`,
  });
  return { batch, run, items };
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function rpcErrorMessage(value: unknown, fallback: string) {
  if (!value || typeof value !== "object") return fallback;
  const record = value as Record<string, unknown>;
  const json = record.json && typeof record.json === "object" ? record.json as Record<string, unknown> : record;
  return typeof json.message === "string" ? json.message : typeof json.code === "string" ? json.code : fallback;
}

function effectiveVerified(output: z.infer<typeof verifyOutputSchema>, supersededFactsRefs: ReadonlySet<string>) {
  return output.verified + output.items.filter((item) => {
    const remaining = item.problems.filter((problem) => !(problem === "facts_not_latest" && supersededFactsRefs.has(item.clientRef)));
    return item.problems.length > 0 && remaining.length === 0 && item.mismatches.length === 0;
  }).length;
}

function verifyProblems(
  output: z.infer<typeof verifyOutputSchema>,
  allowOpen: boolean,
  supersededFactsRefs: ReadonlySet<string>,
) {
  // Jakarta 当前会在 run 仍 open 时固定返回 run_not_completed；full run 又必须先回读再 complete。
  // 因此第一次门禁只忽略这一项，complete 后立刻做第二次回读并要求 problems 真正为空。
  const problems = output.problems.filter((problem) => !(allowOpen && problem === "run_not_completed"));
  if (!output.found) problems.push("run_not_found");
  const verified = effectiveVerified(output, supersededFactsRefs);
  if (verified !== output.expected) problems.push(`verified ${verified}/${output.expected}`);
  for (const item of output.items) {
    for (const problem of item.problems) {
      if (problem === "facts_not_latest" && supersededFactsRefs.has(item.clientRef)) continue;
      problems.push(`${item.clientRef}: ${problem}`);
    }
    for (const mismatch of item.mismatches) problems.push(`${item.clientRef}: ${mismatch.field} 回读不一致`);
  }
  return [...new Set(problems)];
}

function supersededFactsClientRefs(
  items: z.infer<typeof observationItemSchema>[],
  results: z.infer<typeof ingestResultSchema>[],
) {
  const itemByRef = new Map(items.map((item, index) => [item.clientRef, { item, index }]));
  const groups = new Map<string, Array<{ clientRef: string; capturedAt: number; index: number }>>();
  for (const result of results) {
    if (!result.productId || !result.facts?.factsHash) continue;
    const source = itemByRef.get(result.clientRef);
    if (!source?.item.facts) continue;
    const rows = groups.get(result.productId) ?? [];
    rows.push({ clientRef: result.clientRef, capturedAt: Date.parse(source.item.facts.capturedAt ?? source.item.capturedAt), index: source.index });
    groups.set(result.productId, rows);
  }
  const superseded = new Set<string>();
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    rows.sort((left, right) => left.capturedAt - right.capturedAt || left.index - right.index);
    const latest = rows.at(-1)!;
    const previous = rows.at(-2)!;
    // 同时刻的 append-only 记录没有确定性先后，不擅自忽略回读冲突。
    if (latest.capturedAt === previous.capturedAt) continue;
    for (const row of rows.slice(0, -1)) superseded.add(row.clientRef);
  }
  return superseded;
}

export class ProductObservationClient {
  private readonly baseUrl: string;

  constructor(private readonly options: {
    baseUrl: string;
    token?: string;
    apiKey?: string;
    fetch?: FetchLike;
    timeoutMs?: number;
    retries?: number;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  private async call(name: "ingestObservationBatch" | "verifyObservationBatch" | "completeCrawlRun", input: unknown) {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const attempts = Math.max(1, (this.options.retries ?? 2) + 1);
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetchImpl(`${this.baseUrl}/rpc/product/${name}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
            ...(this.options.apiKey ? { "x-api-key": this.options.apiKey } : {}),
          },
          body: JSON.stringify({ json: input }),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
        });
        const body = await response.json().catch(() => null) as unknown;
        if (!response.ok) {
          const error = Object.assign(
            new Error(`Product Server ${name} HTTP ${response.status}: ${rpcErrorMessage(body, response.statusText)}`),
            { retryable: response.status >= 500 || response.status === 408 || response.status === 429 },
          );
          if (response.status < 500 && response.status !== 408 && response.status !== 429) throw error;
          lastError = error;
        } else {
          if (!body || typeof body !== "object" || !("json" in body)) throw new Error(`Product Server ${name} 返回了非法 oRPC 响应`);
          return (body as { json: unknown }).json;
        }
      } catch (error) {
        if ((error as { retryable?: boolean }).retryable === false) throw error;
        lastError = error;
        if (attempt + 1 >= attempts) break;
      }
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
    throw lastError instanceof Error ? lastError : new Error(`Product Server ${name} 调用失败`);
  }

  async ingestAndValidate(rawBatch: unknown, context: { runId: string; sourceUrl: string }) {
    let prepared: ReturnType<typeof buildObservationPayload>;
    try {
      prepared = buildObservationPayload(rawBatch, context);
    } catch (error) {
      return {
        loaded: 0,
        verified: 0,
        problems: [error instanceof Error ? error.message : String(error)],
        records: [],
        readbackHash: createHash("sha256").update("empty").digest("hex"),
        scope: null,
        deactivated: 0,
      };
    }

    const ingestOutputs: z.infer<typeof ingestOutputSchema>[] = [];
    for (let index = 0; index < prepared.items.length; index += 200) {
      const input = observationBatchInputSchema.parse({ run: prepared.run, items: prepared.items.slice(index, index + 200) });
      ingestOutputs.push(ingestOutputSchema.parse(await this.call("ingestObservationBatch", input)));
    }
    const results = ingestOutputs.flatMap((output) => output.results);
    const supersededFactsRefs = supersededFactsClientRefs(prepared.items, results);
    const problems: string[] = [];
    for (const result of results) {
      if (result.status === "failed") problems.push(`${result.clientRef}: ${result.error?.code ?? "failed"}: ${result.error?.message ?? "入库失败"}`);
      if (result.identity?.state === "needs_review" || result.identity?.state === "variant_unresolved") {
        problems.push(`${result.clientRef}: identity_${result.identity.state}`);
      }
    }

    const expectations = prepared.items.map((item) => {
      const result = results.find((candidate) => candidate.clientRef === item.clientRef);
      return {
        clientRef: item.clientRef,
        ...(parsePriceString(item.price) ? { price: parsePriceString(item.price)! } : {}),
        ...(item.currency ? { currency: item.currency } : {}),
        ...(result?.facts?.factsHash && !supersededFactsRefs.has(item.clientRef) ? { factsHash: result.facts.factsHash } : {}),
      };
    });
    const preVerify: z.infer<typeof verifyOutputSchema>[] = [];
    for (let index = 0; index < expectations.length; index += 500) {
      const expect = expectations.slice(index, index + 500);
      const output = verifyOutputSchema.parse(await this.call("verifyObservationBatch", {
        runId: prepared.run.runId,
        clientRefs: expect.map((item) => item.clientRef),
        expect,
      }));
      preVerify.push(output);
      problems.push(...verifyProblems(output, true, supersededFactsRefs));
    }

    if (problems.length > 0) {
      return {
        loaded: results.filter((result) => result.status === "ok").length,
        verified: preVerify.reduce((sum, output) => sum + effectiveVerified(output, supersededFactsRefs), 0),
        problems: [...new Set(problems)],
        records: results,
        readbackHash: createHash("sha256").update(preVerify.map((output) => output.readbackHash).join("|")).digest("hex"),
        scope: prepared.run.scope,
        deactivated: 0,
      };
    }

    const completion = completeOutputSchema.parse(await this.call("completeCrawlRun", {
      runId: prepared.run.runId,
      completedAt: new Date().toISOString(),
      status: "completed",
    }));
    problems.push(...completion.problems);
    if (!completion.found) problems.push("complete_run_not_found");

    const postVerify: z.infer<typeof verifyOutputSchema>[] = [];
    if (problems.length === 0) {
      for (let index = 0; index < expectations.length; index += 500) {
        const expect = expectations.slice(index, index + 500);
        const output = verifyOutputSchema.parse(await this.call("verifyObservationBatch", {
          runId: prepared.run.runId,
          clientRefs: expect.map((item) => item.clientRef),
          expect,
        }));
        postVerify.push(output);
        problems.push(...verifyProblems(output, false, supersededFactsRefs));
      }
    }
    const finalVerify = postVerify.length > 0 ? postVerify : preVerify;
    return {
      loaded: results.filter((result) => result.status === "ok").length,
      verified: finalVerify.reduce((sum, output) => sum + effectiveVerified(output, supersededFactsRefs), 0),
      problems: [...new Set(problems)],
      records: results,
      readbackHash: createHash("sha256").update(finalVerify.map((output) => output.readbackHash).join("|")).digest("hex"),
      scope: completion.scope,
      deactivated: completion.deactivated,
      completion,
    };
  }
}
