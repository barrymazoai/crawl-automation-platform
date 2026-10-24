import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  pageBrandName,
  recaptureHistory,
  sourceIndex,
  type RecaptureCandidate,
  type RecaptureSource,
} from "./history-recapture.js";

const id = (serial: number) => `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`;
const brands = {
  now: id(101),
  vitamatic: id(102),
  pure: id(103),
  gardenOfLife: id(104),
  horbaach: id(105),
  healthySolutions: id(106),
  natureMade: id(107),
  pharmavite: id(108),
  michaels: id(109),
  natureBounty: id(110),
};
const source = (serial: number, brand: [string, string], url: string): RecaptureSource => ({
  sourceId: id(serial),
  brandId: brand[0],
  brandName: brand[1],
  url,
});
const horbaachList =
  "https://www.amazon.com/s?k=Horb%C3%A4ach&i=hpc&rh=n%3A3760901%2Cp_123%3A453712&dc=";
// Shapes of real Amazon sources (search lists with k=, store pages with and without a path name).
const nowSearch = source(
  1,
  [brands.now, "NOW Foods"],
  "https://www.amazon.com/s?k=NOW+Foods&i=hpc",
);
const nowStore = source(
  2,
  [brands.now, "NOW Foods"],
  "https://www.amazon.com/stores/NOWFoods/page/1EB60D86-FEF6-4D8C-A18A-9988BC7C38BB",
);
const vitamatic = source(
  3,
  [brands.vitamatic, "Vitamatic"],
  "https://www.amazon.com/stores/page/1EB60D86-FEF6-4D8C-A18A-9988BC7C38BC",
);
const pure1 = source(
  4,
  [brands.pure, "Pure Encapsulations"],
  "https://www.amazon.com/s?k=Pure+Encapsulations",
);
const pure2 = source(
  5,
  [brands.pure, "Pure Encapsulations"],
  "https://www.amazon.com/s?k=Pure+Encapsulations&i=hpc",
);
const garden = source(
  6,
  [brands.gardenOfLife, "Garden of Life"],
  "https://www.amazon.com/s?k=Garden+of+Life",
);
// The same search list registered under two brands: the brand whose name contains the page brand wins.
const horbaach = source(7, [brands.horbaach, "Horbaach Manufacturing LLC"], horbaachList);
const healthy = source(8, [brands.healthySolutions, "Healthy Natural Solutions"], horbaachList);
const pharmaviteList = source(
  9,
  [brands.pharmavite, "Pharmavite"],
  "https://www.amazon.com/s?k=Nature+Made",
);
const natureMadeStore = source(
  10,
  [brands.natureMade, "Nature Made"],
  "https://www.amazon.com/stores/NatureMade/page/1EB60D86-FEF6-4D8C-A18A-9988BC7C38BD",
);
const michaels = source(
  11,
  [brands.michaels, "Michael's Naturopathic Programs"],
  "https://www.amazon.com/s?k=Michael%27s+Naturopathic",
);
const sources = [
  nowSearch,
  nowStore,
  vitamatic,
  pure1,
  pure2,
  garden,
  horbaach,
  healthy,
  pharmaviteList,
  natureMadeStore,
  michaels,
  source(12, [brands.now, "Broken"], "not a url"),
];
const candidate = (
  listingId: string,
  pageBrand: string | null,
  extra: Partial<RecaptureCandidate> = {},
): RecaptureCandidate => ({
  listingId,
  observedAt: "2026-09-28T07:00:25.338Z",
  pageBrand,
  ownerBrandId: null,
  queuedSourceId: null,
  ...extra,
});

describe("history recapture source resolution", () => {
  const resolve = sourceIndex(sources);
  const sourceOf = (entry: RecaptureCandidate) => {
    const resolution = resolve(entry);
    return "unresolved" in resolution ? resolution : resolution.source.sourceId;
  };

  it("reads the brand from the page byline, in any case", () => {
    expect(pageBrandName("Visit the Vitamatic Store")).toBe("Vitamatic");
    expect(pageBrandName("visit the Vitamatic store")).toBe("Vitamatic");
    expect(pageBrandName("Brand: Herb Pharm")).toBe("Herb Pharm");
  });

  it("keeps the source that last queued the listing only while the page agrees", () => {
    const queued = { queuedSourceId: garden.sourceId };
    expect(resolve(candidate("B0GRLJ6TPJ", "Visit the Garden of Life Store", queued))).toEqual({
      source: garden,
      via: "queued_source",
    });
    expect(resolve(candidate("B0GRLJ6TPK", "Visit the NOW Foods Store", queued))).toEqual({
      unresolved: "queued_source_conflict",
    });
  });

  it("matches the page brand: the brand named exactly, then the search list, then the containing name", () => {
    expect(sourceOf(candidate("B0013OQGO6", "Visit the NOW Foods Store"))).toBe(nowSearch.sourceId);
    expect(sourceOf(candidate("B0FFVMFTDC", "Visit the Vitamatic Store"))).toBe(vitamatic.sourceId);
    expect(sourceOf(candidate("B0002VG3PS", "Visit the Nature Made Store"))).toBe(
      natureMadeStore.sourceId,
    );
    expect(sourceOf(candidate("B0B3J1QWDB", "Visit the Horbäach Store"))).toBe(horbaach.sourceId);
  });

  it("falls back to the capture's own brand when the page names none or names that brand", () => {
    const owner = { ownerBrandId: brands.michaels };
    expect(sourceOf(candidate("B01B36ABQW", "Visit the MICHAEL'S Store", owner))).toBe(
      michaels.sourceId,
    );
    expect(sourceOf(candidate("B01B36ABQX", null, owner))).toBe(michaels.sourceId);
    // The page names another brand than the owner: never the owner's source.
    expect(
      sourceOf(candidate("B0FH6NJKFJ", "Visit the Fabuday Store", { ownerBrandId: brands.now })),
    ).toEqual({ unresolved: "no_enabled_source" });
  });

  it("never guesses: no byline, no enabled source, or two equal sources stay unresolved", () => {
    expect(sourceOf(candidate("B000000001", null))).toEqual({ unresolved: "no_page_brand" });
    expect(sourceOf(candidate("B0016A3Y7E", "Visit the Herb Pharm Store"))).toEqual({
      unresolved: "no_enabled_source",
    });
    expect(sourceOf(candidate("B002REMQ36", "Brand: Pure Encapsulations"))).toEqual({
      unresolved: "ambiguous_source",
    });
  });
});

describe("recaptureHistory", () => {
  const candidates = [
    candidate("B0FFVMFTDC", "Visit the Vitamatic Store", { ownerBrandId: brands.vitamatic }),
    candidate("B0CZM6718H", "Visit the Horbäach Store", { ownerBrandId: brands.natureBounty }),
    candidate("B0016A3Y7E", "Visit the Herb Pharm Store"),
  ];
  const store = {
    recaptureCandidates: vi.fn(async () => candidates),
    enabledSources: vi.fn(async () => sources),
  };
  const input = {
    channel: "amazon" as const,
    lastObservedBefore: "2026-10-01T00:00:00Z",
    limit: 2,
    dryRun: true,
  };

  it("previews without queueing, with brand changes and the batch to confirm", async () => {
    const add = vi.fn();
    const result = await recaptureHistory({ store, add }, input);
    expect(add).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      candidates: 3,
      notCandidates: [],
      resolved: 2,
      brandChanges: 1,
      selected: 2,
      unresolved: { no_enabled_source: 1 },
      unresolvedBrands: [{ pageBrand: "Herb Pharm", reason: "no_enabled_source", count: 1 }],
    });
    expect(z.uuid().safeParse(result.batchId).success).toBe(true);
  });

  it("restricts the candidates to named ASINs and says which are not candidates", async () => {
    const result = await recaptureHistory(
      { store, add: vi.fn() },
      { ...input, listingIds: ["B0FFVMFTDC", "B0000NOPE0"] },
    );
    expect(result).toMatchObject({ candidates: 1, selected: 1, notCandidates: ["B0000NOPE0"] });
  });

  it("queues only the previewed selection, under its batch ID", async () => {
    const add = vi.fn(async () => ({ added: 2 }));
    const preview = await recaptureHistory({ store, add }, input);
    const expectBatchId = preview.batchId ?? "";
    const queued = await recaptureHistory(
      { store, add },
      { ...input, dryRun: false, expectBatchId },
    );
    expect(add).toHaveBeenCalledExactlyOnceWith({
      channel: "amazon",
      batchId: expectBatchId,
      label: "history recapture: last captured before 2026-10-01",
      products: [
        {
          sourceId: vitamatic.sourceId,
          url: "https://www.amazon.com/dp/B0FFVMFTDC",
          listingId: "B0FFVMFTDC",
          variantId: null,
        },
        {
          sourceId: horbaach.sourceId,
          url: "https://www.amazon.com/dp/B0CZM6718H",
          listingId: "B0CZM6718H",
          variantId: null,
        },
      ],
    });
    expect(queued).toMatchObject({ dryRun: false, selected: 2, added: 2, following: 0 });
    await expect(
      recaptureHistory({ store, add }, { ...input, limit: 1, dryRun: false, expectBatchId }),
    ).rejects.toMatchObject({ code: "QUEUE.RECAPTURE_SELECTION_CHANGED" });
    expect(add).toHaveBeenCalledOnce();
  });
});
