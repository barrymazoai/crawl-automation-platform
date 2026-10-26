import { describe, expect, it, vi } from "vitest";
import { enrichmentChange, EnrichmentUpdate, type EnrichmentOutcome } from "./enrichment-update.js";
import type { EnrichmentNames, RefreshedEnrichment } from "./ledger.js";

const names = (partial: Partial<EnrichmentNames> = {}): EnrichmentNames => ({
  forms: [],
  healthFunctions: [],
  mainIngredients: [],
  ...partial,
});
const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
] as const;
const product = (
  id: string,
  current: Partial<EnrichmentNames>,
  previous: Partial<EnrichmentNames> = {},
): RefreshedEnrichment => ({
  supplySmartProductId: id,
  current: names(current),
  previous: names(previous),
  sentBeforeCurrent: true,
});
const upToDate = (product: RefreshedEnrichment) => ({ ...product, sentBeforeCurrent: false });

describe("enrichmentChange", () => {
  it("adds the current names and removes only earlier ones no current enrichment sends", () => {
    expect(
      enrichmentChange(
        product(
          ids[0],
          { forms: ["tablet"], healthFunctions: ["Muscle Recovery"], mainIngredients: ["Whey"] },
          {
            forms: ["chewable", "Tablet"],
            healthFunctions: ["support optimal protein synthesis and recovery", "muscle  recovery"],
            mainIngredients: ["Whey", "Creatine"],
          },
        ),
      ),
    ).toEqual({
      productId: ids[0],
      add: {
        productForm: "tablet",
        healthFunctions: ["Muscle Recovery"],
        mainIngredients: ["Whey"],
      },
      remove: {
        forms: ["chewable"],
        healthFunctions: ["support optimal protein synthesis and recovery"],
        mainIngredients: ["Creatine"],
      },
    });
  });

  it("skips a product sent after its current enrichment with nothing earlier to take back", () => {
    expect(enrichmentChange(upToDate(product(ids[0], { healthFunctions: ["Calm"] })))).toBeNull();
    const same = product(ids[0], { healthFunctions: ["Calm"] }, { healthFunctions: ["calm"] });
    expect(enrichmentChange(upToDate(same))).toBeNull();
  });
});

function setup(products: RefreshedEnrichment[], outcomes: EnrichmentOutcome[]) {
  const refreshedEnrichments = vi.fn(async () => products);
  const update = vi.fn(async () => outcomes);
  const run = new EnrichmentUpdate({ ledger: { refreshedEnrichments }, supplySmart: { update } });
  return { run, refreshedEnrichments, update };
}

const empty = { forms: [], healthFunctions: [], mainIngredients: [] };

describe("EnrichmentUpdate", () => {
  it("is a dry run by default, sends one batch, counts changes and keeps per-product failures", async () => {
    const { run, update, refreshedEnrichments } = setup(
      [
        product(
          ids[0],
          { healthFunctions: ["Joint Health"] },
          { healthFunctions: ["supports joints"] },
        ),
        product(ids[1], { forms: ["capsule"] }, {}),
      ],
      [
        {
          productId: ids[0],
          ok: true,
          added: { ...empty, healthFunctions: ["Joint Health"] },
          removed: { ...empty, healthFunctions: ["supports joints"] },
        },
        { productId: ids[1], ok: false, code: "NOT_FOUND", message: "Product not found" },
      ],
    );
    const report = await run.run({ limit: 2, after: ids[0] });
    expect(refreshedEnrichments).toHaveBeenCalledWith({ after: ids[0], limit: 2 });
    expect(update).toHaveBeenCalledWith(expect.any(Array), true, expect.any(AbortSignal));
    expect(report).toMatchObject({
      dryRun: true,
      checked: 2,
      skipped: 0,
      updated: 1,
      added: { forms: 0, healthFunctions: 1, mainIngredients: 0 },
      removed: { forms: 0, healthFunctions: 1, mainIngredients: 0 },
      failures: [{ productId: ids[1], code: "NOT_FOUND", message: "Product not found" }],
      next: ids[1],
    });
    expect(report.examples).toHaveLength(1);
  });

  it("calls Supply Smart only when a product needs a change", async () => {
    const { run, update } = setup([upToDate(product(ids[0], { healthFunctions: ["Calm"] }))], []);
    expect(await run.run({ limit: 5, dryRun: false })).toMatchObject({
      dryRun: false,
      checked: 1,
      skipped: 1,
      updated: 0,
      next: null,
    });
    expect(update).not.toHaveBeenCalled();
  });
});
