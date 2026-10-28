import { describe, expect, it, vi } from "vitest";
import { RetainedPublication, type ObjectStore } from "@crawl-automation/platform";
import type { DtcBrandScanResult, DtcListedProduct } from "./brand-scan.js";
import { DtcScanRelevance, type DtcRelevanceModel } from "./scan-relevance.js";

const signal = new AbortController().signal;
const item = (id: string, productType: string | null, variants = 1): DtcListedProduct[] =>
  Array.from({ length: variants }, (_, index) => ({
    url: `https://shop.example/products/${id}?variant=${index + 1}`,
    listingId: id,
    variantId: String(index + 1),
    title: `${id} - ${index + 1}`,
    kind: "product",
    brand: "Shop",
    seller: "shop.example",
    brandBasis: "source",
    brandEvidence: {} as DtcListedProduct["brandEvidence"],
    productTitle: id,
    productType,
    tags: [],
  }));
const scanResult = (products: DtcListedProduct[]): DtcBrandScanResult => ({
  sourceUrl: "https://shop.example/collections/all",
  source: {} as DtcBrandScanResult["source"],
  pages: [{ products, cards: products.length, nextPage: null, statedTotal: null }],
  complete: true,
  soldHere: true,
  archiveKeys: [],
  stopped: "end",
});

function fixture(answer: (ids: string[]) => unknown) {
  const data = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    read: async (key) => data.get(key) ?? null,
    create: async (key, bytes) => (data.has(key) ? "exists" : (data.set(key, bytes), "created")),
  };
  const model = vi.fn<DtcRelevanceModel>(async ({ prompt }) => {
    const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map((match) => match[1] ?? "");
    return JSON.stringify(answer(ids));
  });
  return {
    relevance: new DtcScanRelevance({ publication: new RetainedPublication(store, store), model }),
    model,
  };
}
const verdicts = (verdict: Record<string, string>) => (ids: string[]) => ({
  products: ids.map((id) => ({ id, verdict: verdict[id] ?? "supplement", reason: `${id} reason` })),
});
const excludedIds = (result: DtcBrandScanResult) =>
  result.pages
    .flatMap((page) => page.products)
    .filter((product) => product.excluded)
    .map((product) => product.listingId);

describe("DTC scan supplement judgement", () => {
  it("ends a never-collect store type without the model and marks every variant of a model-excluded product", async () => {
    const { relevance, model } = fixture(verdicts({ belt: "not_supplement", mystery: "unsure" }));
    const result = await relevance.judge(
      scanResult([
        ...item("gift-card", "Gift Card"),
        ...item("belt", "Gym Accessories", 3),
        ...item("whey", null),
        ...item("mystery", null),
      ]),
      signal,
    );
    expect(excludedIds(result)).toEqual(["gift-card", "belt", "belt", "belt"]);
    expect(model).toHaveBeenCalledTimes(1);
    expect(model.mock.calls[0]?.[0].prompt).not.toContain("gift-card");
    const belt = result.pages[0]?.products.find(
      (product) => product.listingId === "belt",
    )?.excluded;
    expect(belt).toMatchObject({ basis: "model", reason: "belt reason" });
    expect(belt?.evidenceKey).toMatch(/^v3\/dtc-scan-relevance\/[a-f0-9]{64}\/answer\.json$/);
  });

  it("reuses a retained answer for the same products instead of asking again", async () => {
    const { relevance, model } = fixture(verdicts({ belt: "not_supplement" }));
    const products = [...item("belt", null), ...item("whey", null)];
    await relevance.judge(scanResult(products), signal);
    const again = await relevance.judge(scanResult(products), signal);
    expect(model).toHaveBeenCalledTimes(1);
    expect(excludedIds(again)).toEqual(["belt"]);
  });

  it.each([
    [
      "the model fails",
      () => {
        throw new Error("model down");
      },
    ],
    [
      "the answer names a product outside its batch",
      (ids: string[]) => verdicts({})([...ids, "other"]),
    ],
    [
      "the answer names a product twice",
      (ids: string[]) => verdicts({ belt: "not_supplement" })([...ids, ids[0] ?? ""]),
    ],
  ])("queues everything as before when %s", async (_case, answer) => {
    const { relevance } = fixture(answer);
    const result = await relevance.judge(
      scanResult([...item("belt", null), ...item("whey", null)]),
      signal,
    );
    expect(excludedIds(result)).toEqual([]);
  });
});
