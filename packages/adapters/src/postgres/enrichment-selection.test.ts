import { expect, it, vi } from "vitest";
import { missingEnrichment, MISSING_ENRICHMENT } from "./enrichment-selection.js";
import type { Queryable } from "@crawl-automation/platform";

it("selects both collected and linked formulas with null-safe variant filtering and a stable bound", async () => {
  const query = vi.fn(async () => [
    { operation_id: "own", channel: "gnc", listing_id: "one", variant_id: null },
    { operation_id: "sibling", channel: "swanson", listing_id: "two", variant_id: "large" },
  ]);
  expect(await missingEnrichment({ query } as Queryable, 2)).toEqual([
    { collectionOperationId: "own", channel: "gnc", listingId: "one", variantId: null },
    { collectionOperationId: "sibling", channel: "swanson", listingId: "two", variantId: "large" },
  ]);
  expect(query).toHaveBeenCalledWith(MISSING_ENRICHMENT, [2]);
  expect(MISSING_ENRICHMENT).toContain("FROM formula_link");
  expect(MISSING_ENRICHMENT).toContain("NOT EXISTS");
  expect(MISSING_ENRICHMENT).toContain("IS NOT DISTINCT FROM");
  expect(MISSING_ENRICHMENT).toContain("LIMIT $1");
});

it("also lists reconciled channel-family formulas when migration 040 is installed", async () => {
  const query = vi
    .fn<(sql: string, values?: readonly unknown[]) => Promise<object[]>>()
    .mockResolvedValueOnce([{ available: true }])
    .mockResolvedValueOnce([
      {
        operation_id: "amazon-label",
        channel: "wholefoods",
        listing_id: "B000000001",
        variant_id: null,
      },
    ]);
  expect(await missingEnrichment({ query } as Queryable, 1)).toEqual([
    {
      collectionOperationId: "amazon-label",
      channel: "wholefoods",
      listingId: "B000000001",
      variantId: null,
    },
  ]);
  expect(query.mock.calls[1]?.[0]).toContain(
    "FROM family_formula_outcome WHERE status = 'formula-linked'",
  );
  expect(query.mock.calls[1]?.[1]).toEqual([1]);
});
