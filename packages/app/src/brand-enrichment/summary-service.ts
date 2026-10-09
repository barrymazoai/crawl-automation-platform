import { z } from "zod";
import {
  BrandEnrichmentSummarySchema,
  CompanyEnrichmentResultSchema,
  CompanySchema,
  type BrandEnrichmentSummary,
} from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns } from "./ports.js";
import { BrandApolloResultSchema } from "./apollo-service.js";
export class BrandSummaryService {
  constructor(private readonly deps: { runs: BrandEnrichmentRuns }) {}
  async build(runId: string) {
    const runs = this.deps.runs;
    const summary = BrandEnrichmentSummarySchema.parse({});
    const product = z
      .object({ captured: z.number(), review: z.number() })
      .safeParse(await runs.step(runId, "products"));
    if (product.success) {
      summary.products = product.data;
    }
    const apollo = BrandApolloResultSchema.safeParse(await runs.step(runId, "apollo"));
    if (apollo.success) {
      summary.apollo = {
        status: apollo.data.status,
        attempts: apollo.data.attempts,
        ...(apollo.data.apollo ? { by: apollo.data.apollo.match.by } : {}),
      };
    }
    summary.profile = await this.profile(runId);
    const contacts = z
      .object({ total: z.number().int().min(0) })
      .safeParse(await runs.step(runId, "contacts"));
    if (contacts.success) {
      summary.contacts = contacts.data.total;
    }
    const ownership = z
      .enum(["has_parent", "independent", "waiting_for_person"])
      .safeParse(await runs.step(runId, "ownership"));
    if (ownership.success) {
      summary.ownership = ownership.data;
    }
    const family = await this.family(runId);
    if (family) {
      summary.family = family;
      summary.products = await this.products(runId, summary.products);
    }
    return BrandEnrichmentSummarySchema.parse(summary);
  }
  private async profile(runId: string) {
    const written = CompanyEnrichmentResultSchema.safeParse(
      await this.deps.runs.step(runId, "write"),
    );
    if (
      written.success &&
      (written.data.updatedFields.some((field) => ["description", "keywords"].includes(field)) ||
        written.data.categories.added > 0)
    ) {
      return "filled";
    }
    const company = CompanySchema.safeParse(await this.deps.runs.step(runId, "identity-company"));
    return company.success && (company.data.description || company.data.keywords?.length)
      ? "kept_existing"
      : "missing";
  }
  private async products(runId: string, root: BrandEnrichmentSummary["products"]) {
    const children = await this.deps.runs.list({ parentRunId: runId, limit: 1000 });
    const totals = children
      .filter((child) => child.role === "sub_brand")
      .map((child) => child.summary?.products);
    return totalProducts([root, ...totals]);
  }
  private async family(runId: string) {
    const family = BrandEnrichmentSummarySchema.shape.family.safeParse(
      await this.deps.runs.step(runId, "family-summary"),
    );
    if (!family.success || !family.data) {
      return undefined;
    }
    const children = await this.deps.runs.list({ parentRunId: runId, limit: 1000 });
    return {
      ...family.data,
      subBrands: family.data.subBrands.map((brand) => {
        const child = children.find(
          (item) => item.role === "sub_brand" && item.companyId === brand.companyId,
        );
        return child
          ? {
              ...brand,
              status: child.state === "completed" ? ("completed" as const) : ("failed" as const),
            }
          : brand;
      }),
    };
  }
}

function totalProducts(
  products: ({ captured?: number | undefined; review?: number | undefined } | undefined)[],
) {
  if (!products.some((item) => item !== undefined)) {
    return undefined;
  }
  return products.reduce<{ captured: number; review: number }>(
    (sum, item) => ({
      captured: sum.captured + (item?.captured ?? 0),
      review: sum.review + (item?.review ?? 0),
    }),
    { captured: 0, review: 0 },
  );
}
