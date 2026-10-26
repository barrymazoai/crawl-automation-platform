import { expect, it, vi } from "vitest";
import type { NotSupplementDelivered, ProductSyncLedger } from "./ledger.js";
import {
  NotSupplementRemoval,
  type SupplySmartProductFacts,
  type SupplySmartProducts,
} from "./not-supplement-removal.js";

// Real GNC listings the store files outside supplements (socks, shaker), 2026-10-26.
const candidate = (
  listingId: string,
  productId: string,
  extra: Partial<NotSupplementDelivered> = {},
): NotSupplementDelivered => ({
  channel: "gnc",
  listingId,
  variantId: null,
  supplySmartProductId: productId,
  supplySmartListingId: `listing-${listingId}`,
  productRemoved: false,
  ...extra,
});
const crawlerShell = (listingId: string): SupplySmartProductFacts => ({
  source: "enrichment",
  listings: [{ id: `listing-${listingId}`, channel: "gnc" }],
  formulaId: null,
  formulaObservations: 0,
});

function setup(
  candidates: NotSupplementDelivered[],
  facts: Record<string, SupplySmartProductFacts>,
) {
  const markRemoved = vi.fn(async () => undefined);
  const notSupplementsDelivered = vi.fn(async () => candidates);
  const products: SupplySmartProducts = {
    facts: vi.fn(async (id: string) => {
      const known = facts[id];
      if (!known) {
        throw new Error(`Product with ID ${id} not found`);
      }
      return known;
    }),
    delete: vi.fn(async () => undefined),
  };
  const removal = new NotSupplementRemoval({
    ledger: { markRemoved, notSupplementsDelivered } as unknown as ProductSyncLedger,
    products,
  });
  return { removal, products, markRemoved, notSupplementsDelivered };
}

it("a dry run decides every candidate in Supply Smart and changes nothing", async () => {
  const { removal, products, markRemoved } = setup(
    [candidate("574389", "p-socks"), candidate("610673", "p-shaker")],
    { "p-socks": crawlerShell("574389"), "p-shaker": crawlerShell("610673") },
  );
  expect(await removal.run({ limit: 10 })).toMatchObject({
    dryRun: true,
    checked: 2,
    removable: 2,
    removed: 0,
    failure: null,
    next: null,
  });
  expect(products.delete).not.toHaveBeenCalled();
  expect(markRemoved).not.toHaveBeenCalled();
});

it("deletes only crawler-created single-listing products without a formula", async () => {
  const facts = {
    "p-socks": crawlerShell("574389"),
    "p-legacy": { ...crawlerShell("100"), source: "link-monitor" },
    "p-two": {
      ...crawlerShell("200"),
      listings: [...crawlerShell("200").listings, { id: "wf-listing", channel: "wholefoods" }],
    },
    "p-moved": { ...crawlerShell("300"), listings: [{ id: "other-listing", channel: "gnc" }] },
    "p-formula": { ...crawlerShell("400"), formulaObservations: 1 },
  };
  const { removal, products, markRemoved } = setup(
    [
      candidate("574389", "p-socks"),
      candidate("100", "p-legacy"),
      candidate("200", "p-two"),
      candidate("300", "p-moved"),
      candidate("400", "p-formula"),
    ],
    facts,
  );
  const report = await removal.run({ limit: 10, dryRun: false });
  expect(report).toMatchObject({ checked: 5, removable: 1, removed: 1, failure: null });
  expect(report.kept.map((entry) => [entry.listingId, entry.reason])).toEqual([
    ["100", "PRODUCT_SYNC.KEEP_NOT_CRAWLER_CREATED"],
    ["200", "PRODUCT_SYNC.KEEP_OTHER_LISTINGS"],
    ["300", "PRODUCT_SYNC.KEEP_OTHER_LISTINGS"],
    ["400", "PRODUCT_SYNC.KEEP_HAS_FORMULA"],
  ]);
  expect(products.delete).toHaveBeenCalledExactlyOnceWith("p-socks", expect.any(AbortSignal));
  expect(markRemoved).toHaveBeenCalledExactlyOnceWith({
    channel: "gnc",
    listingId: "574389",
    variantId: null,
  });
});

it("two variant rows of one product delete it once and record both rows", async () => {
  const { removal, products, markRemoved } = setup(
    [
      candidate("610673", "p-shaker", { variantId: "black" }),
      candidate("610673", "p-shaker", { variantId: "white" }),
      // An earlier run already removed this product through another row.
      candidate("620000", "p-gone", { productRemoved: true }),
    ],
    { "p-shaker": crawlerShell("610673") },
  );
  expect(await removal.run({ limit: 10, dryRun: false })).toMatchObject({
    checked: 1,
    removed: 1,
    sameProduct: 2,
    failure: null,
  });
  expect(products.delete).toHaveBeenCalledOnce();
  expect(products.facts).toHaveBeenCalledOnce();
  expect(markRemoved).toHaveBeenCalledTimes(3);
});

it("the first failure stops the run with what was done before it and no next page", async () => {
  const { removal, products, markRemoved } = setup(
    [candidate("1", "p-1"), candidate("2", "p-2"), candidate("3", "p-3")],
    { "p-1": crawlerShell("1"), "p-2": crawlerShell("2"), "p-3": crawlerShell("3") },
  );
  vi.mocked(products.delete)
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(
      Object.assign(new Error("Supply Smart refused or failed the call."), {
        details: { path: "product.delete", status: 403 },
      }),
    );
  const report = await removal.run({ limit: 3, dryRun: false });
  expect(report).toMatchObject({
    removed: 1,
    failure: { productId: "p-2", details: { path: "product.delete", status: 403 } },
    next: null,
  });
  expect(markRemoved).toHaveBeenCalledOnce();
  expect(products.facts).toHaveBeenCalledTimes(2);
});

it("a full page answers the key to continue after, including kept products", async () => {
  const { removal, notSupplementsDelivered } = setup(
    [candidate("1", "p-1"), candidate("2", "p-2", { variantId: "v" })],
    { "p-1": { ...crawlerShell("1"), source: "NIH" }, "p-2": crawlerShell("2") },
  );
  const after = { channel: "gnc" as const, listingId: "0", variantId: null };
  expect((await removal.run({ channel: "gnc", limit: 2, after })).next).toEqual({
    channel: "gnc",
    listingId: "2",
    variantId: "v",
  });
  expect(notSupplementsDelivered).toHaveBeenCalledExactlyOnceWith({
    channel: "gnc",
    after,
    limit: 2,
  });
});

it("refuses a page larger than 500 before reading anything", async () => {
  const { removal, notSupplementsDelivered } = setup([], {});
  await expect(removal.run({ limit: 501 })).rejects.toThrow();
  expect(notSupplementsDelivered).not.toHaveBeenCalled();
});
