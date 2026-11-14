import { z } from "zod";
import { defineErrors } from "@crawl-automation/platform";

const errors = defineErrors({
  "PRODUCT_SYNC.BRANDS_API_FAILED": {
    category: "RUNTIME",
    message: "Marketplace brand API call failed.",
  },
});
const matched = z.object({
  result: z.object({
    data: z.object({
      checked: z.number(),
      matched: z.number(),
      ambiguous: z.number(),
      unmatched: z.number(),
      errors: z.array(z.object({ brandId: z.string(), name: z.string(), error: z.string() })),
      refreshed: z
        .object({
          checked: z.number(),
          merged: z.number(),
          website: z.number(),
          unchanged: z.number(),
          changes: z.array(
            z.object({
              brandId: z.string(),
              name: z.string(),
              kind: z.enum(["merged", "website"]),
              from: z.object({ companyId: z.string().nullable(), domain: z.string().nullable() }),
              to: z.object({ companyId: z.string().nullable(), domain: z.string().nullable() }),
            }),
          ),
        })
        .optional(),
    }),
  }),
});
const started = z.object({ result: z.object({ data: z.array(z.unknown()) }) });

/** The sync sweep uses the operators' mutations, so a website run starts with the API's own settings. */
export class MarketplaceBrandsApi {
  constructor(
    private readonly baseUrl: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async matchBrands(limit: number, signal: AbortSignal, refreshLimit = 0) {
    const input = { limit, ...(refreshLimit ? { refreshMatched: { limit: refreshLimit } } : {}) };
    return matched.parse(await this.call("productSync.matchBrands", input, signal)).result.data;
  }

  async startMarketplaceBrands(limit: number, signal: AbortSignal) {
    return started.parse(
      await this.call("brandEnrichment.startMarketplaceBrands", { limit }, signal),
    ).result.data;
  }

  private call(path: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    return operatorsApiCall({ baseUrl: this.baseUrl, fetch: this.fetch }, { path, input }, signal);
  }
}

/** One tRPC mutation on the operators' API (`apps/api`), the same path a person uses. */
export async function operatorsApiCall(
  api: { baseUrl: string; fetch: typeof globalThis.fetch },
  { path, input }: { path: string; input: unknown },
  signal: AbortSignal,
): Promise<unknown> {
  const response = await api.fetch(`${api.baseUrl.replace(/\/$/, "")}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
  });
  if (!response.ok) {
    throw errors.create("PRODUCT_SYNC.BRANDS_API_FAILED", {
      details: { path, status: response.status },
    });
  }
  return response.json();
}
