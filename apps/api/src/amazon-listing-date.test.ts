import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { canonicalHash, marketplaceItem, marketplaceLabel } from "@crawl-automation/app";
import {
  ChannelProductEvidenceSchema,
  LabelCollectedProductSchema,
  SharedEnrichmentRecordSchema,
} from "@crawl-automation/v3-contracts";
import { fixture, reader, run, capturedAt } from "./amazon-listing-date.fixture.js";

it.each([
  ["B0013LAQS6", "2007-06-13"],
  ["B0G963NB8Q", "2025-12-19"],
])("%s: saved original → capture history and historical sync payload (%s)", async (asin, date) => {
  const sample = fixture(asin);
  expect(sample.history.observations[0]?.record).toMatchObject({
    extras: { commerce: { dateFirstAvailable: { date } } },
    evidence: [sample.archive],
  });
  const prior = reader(sample);
  const page = await prior.service.read(
    { channel: "amazon", limit: 1 },
    new AbortController().signal,
  );
  const product = page.products[0];
  expect(product?.problem).toBeUndefined();
  if (!product) {
    throw new Error("Missing saved product");
  }
  const item = marketplaceItem(product, { domain: "matched-brand.example", runId: "resync-run" });
  expect(item).toMatchObject({
    listedAt: `${date}T12:00:00.000Z`,
    listedAtSource: "amazon_dfa",
    capturedAt,
    extras: { amazonDfa: sample.parsed.commerce?.dateFirstAvailable },
  });
  // The same reparse carries the root rank; the delivered units name their source (KAN-226).
  const rank = sample.parsed.commerce?.salesRank?.rank;
  expect(rank).toBeGreaterThan(0);
  expect(product.salesRank).toEqual(sample.parsed.commerce?.salesRank);
  expect(item.salesRank).toBe(rank);
  expect(item.unitsSold).toBeGreaterThan(0);
  expect(item.unitsSoldPeriod).toBe("trailing_30d");
  expect(item.extras["salesEstimate"]).toMatchObject({ rank, units: item.unitsSold });
  expect(canonicalHash(prior.raw)).toBe(prior.before);
  expect(product.history?.metrics).toEqual(prior.raw.metrics);
  expect(product.history?.capturedAt).toBe(capturedAt);
  expect(prior.read).toHaveBeenCalledTimes(2);
  expect(prior.read).toHaveBeenCalledWith(
    sample.archive.objectKey,
    8 * 1024 * 1024,
    expect.any(AbortSignal),
  );
});

/** A controlled historical projection of the real saved page, deliberately unlike today's parser output. */
function retainedLabel(sample: ReturnType<typeof fixture>) {
  const product = ChannelProductEvidenceSchema.parse({
    ...sample.parsed.evidence,
    title: "Historical retained title",
    imageCandidates: sample.parsed.evidence.imageCandidates.slice(0, 1),
    variantOptions: ["Size: historical selection"],
    variants: [
      {
        listingId: sample.parsed.evidence.listingId,
        variantId: sample.parsed.evidence.variantId,
        url: sample.page.url,
        title: "Historical retained variant",
        options: { size: "historical selection" },
      },
    ],
  });
  const bytes = Buffer.from(JSON.stringify(product));
  const collection = LabelCollectedProductSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../../../packages/adapters/src/postgres/fixtures/collected-product.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
  collection.observation = {
    ...collection.observation,
    requestId: run.runId,
    sourceId: run.sourceId,
    listingId: product.listingId,
    variantId: product.variantId,
  };
  for (const source of collection.provenance) {
    if (source.kind !== "image" || !("completion" in source.record)) {
      throw new Error("Expected the saved image-label fixture");
    }
    source.record.input.selection.observation = collection.observation;
    for (const reference of [
      source.record.input.selection.image,
      source.record.result,
      source.record.completion,
    ]) {
      Object.assign(reference, {
        sourceId: run.sourceId,
        listingId: product.listingId,
        variantId: product.variantId,
      });
    }
  }
  const hash = "a".repeat(64);
  const enrichment = SharedEnrichmentRecordSchema.parse({
    codec: "product-enrichment/3",
    enrichmentId: hash,
    formulaHash: hash,
    inputHash: hash,
    provider: "codex",
    createdAt: capturedAt,
    variantCode: hash,
    evidenceKey: "saved/enrichment",
    promptSha256: hash,
    responseSha256: hash,
    subject: {
      channel: "amazon",
      listingId: product.listingId,
      variantId: product.variantId,
      collectionOperationId: collection.operationId,
      observation: collection.observation,
      title: product.title,
      titleEvidence: {
        sourceId: "saved/title.json",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
    candidate: {
      unifiedName: product.title,
      baseName: product.title,
      form: "unknown",
      variant: { count: null, size: null, flavor: null, strength: null },
      healthFunctions: [],
      confidence: 1,
      notes: null,
    },
  });
  return { product, bytes, collection, enrichment };
}

it("titleEvidence keeps projection and label bytes; only DFA is added to the observation", async () => {
  const sample = fixture("B0013LAQS6");
  const label = retainedLabel(sample);
  expect(label.product.title).not.toBe(sample.parsed.evidence.title);
  expect(label.product.imageCandidates).not.toEqual(sample.parsed.evidence.imageCandidates);
  expect(label.product.variantOptions).not.toEqual(sample.parsed.evidence.variantOptions);
  expect(label.product.variants).not.toEqual(sample.parsed.evidence.variants);
  const prior = reader(sample, label);
  const page = await prior.service.read(
    { channel: "amazon", limit: 1 },
    new AbortController().signal,
  );
  const after = page.products[0];
  expect(after?.problem).toBeUndefined();
  if (!after) {
    throw new Error("Missing saved product");
  }
  const { dateFirstAvailable: _date, ...baseline } = after;
  // Before DFA, titleEvidence is the selected projection and history metrics are unchanged.
  const before = { ...baseline, product: label.product };
  const options = { domain: "matched-brand.example", runId: "resync-run" };
  expect(JSON.stringify(after.product)).toBe(label.bytes.toString("utf8"));
  const beforeLabel = marketplaceLabel(before, options);
  expect(beforeLabel).not.toBeNull();
  expect(JSON.stringify(marketplaceLabel(after, options))).toBe(JSON.stringify(beforeLabel));
  const beforeItem = marketplaceItem(before, options);
  const item = marketplaceItem(after, options);
  expect({
    listedAt: item.listedAt,
    listedAtSource: item.listedAtSource,
    amazonDfa: item.extras.amazonDfa,
  }).toEqual({
    listedAt: "2007-06-13T12:00:00.000Z",
    listedAtSource: "amazon_dfa",
    amazonDfa: sample.parsed.commerce?.dateFirstAvailable,
  });
  delete item.listedAt;
  delete item.listedAtSource;
  delete item.extras.amazonDfa;
  expect(JSON.stringify(item)).toBe(JSON.stringify(beforeItem));
  expect(canonicalHash(prior.raw)).toBe(prior.before);
  expect(prior.read.mock.calls.map(([key]) => key)).toEqual([
    label.enrichment.subject.titleEvidence?.sourceId,
    sample.archive.objectKey,
  ]);
});

it.each([
  ["missing", "missing"],
  ["NoSuchKey", "missing"],
  ["unreadable", "unreadable"],
  ["corrupt", "hash_mismatch"],
  ["foreign", "identity_mismatch"],
])(
  "a %s original omits optional DFA while preserving the complete prior sync payload",
  async (failure, reason) => {
    const sample = fixture("B0013LAQS6");
    const label = retainedLabel(sample);
    if (failure === "foreign") {
      const foreign = fixture("B0G963NB8Q");
      sample.bytes = foreign.bytes;
      sample.history.raw["evidence"] = [foreign.archive];
    }
    const prior = reader(sample, label);
    if (failure !== "foreign") {
      prior.read.mockImplementation(async (key) => {
        if (key === label.enrichment.subject.titleEvidence?.sourceId) {
          return label.bytes;
        }
        if (failure === "NoSuchKey" || failure === "unreadable") {
          throw Object.assign(new Error("Retained read failed"), { name: failure });
        }
        return failure === "missing" ? null : Buffer.from("corrupt");
      });
    }
    const page = await prior.service.read(
      { channel: "amazon", limit: 1 },
      new AbortController().signal,
    );
    const product = page.products[0];
    expect(product?.problem).toBeUndefined();
    if (!product) {
      throw new Error("Missing saved product");
    }
    expect(product.dateFirstAvailableWarning).toMatchObject({ reason });
    const { dateFirstAvailableWarning: _warning, ...before } = product;
    const options = { domain: "matched-brand.example", runId: "resync-run" };
    const item = marketplaceItem(product, options);
    expect(item).not.toHaveProperty("listedAt");
    expect(item).not.toHaveProperty("listedAtSource");
    expect(item.extras).not.toHaveProperty("amazonDfa");
    expect(JSON.stringify(product.product)).toBe(label.bytes.toString("utf8"));
    expect(JSON.stringify(item)).toBe(JSON.stringify(marketplaceItem(before, options)));
    expect(JSON.stringify(marketplaceLabel(product, options))).toBe(
      JSON.stringify(marketplaceLabel(before, options)),
    );
    expect(prior.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason, runId: run.runId }),
      expect.any(String),
    );
    expect(canonicalHash(prior.raw)).toBe(prior.before);
  },
);

it("product projection integrity remains blocking, independently of optional DFA", async () => {
  const sample = fixture("B0013LAQS6");
  const corrupt = reader(sample);
  corrupt.read.mockResolvedValueOnce(Buffer.from("corrupt"));
  const result = await corrupt.service.read(
    { channel: "amazon", limit: 1 },
    new AbortController().signal,
  );
  expect(result.products[0]?.problem).toBe("PRODUCT_DELIVERY.INTEGRITY");
  const foreign = fixture("B0G963NB8Q");
  sample.bytes = foreign.bytes;
  sample.history.raw["evidence"] = [foreign.archive];
  const swapped = reader(sample);
  const wrong = await swapped.service.read(
    { channel: "amazon", limit: 1 },
    new AbortController().signal,
  );
  expect(wrong.products[0]?.dateFirstAvailableWarning).toMatchObject({
    reason: "identity_mismatch",
  });
  const wrongProduct = wrong.products[0];
  if (!wrongProduct) {
    throw new Error("Missing saved product");
  }
  expect(() =>
    marketplaceItem(wrongProduct, { domain: "matched.example", runId: "sync" }),
  ).toThrow();
});

it("cancellation during the optional original read still cancels sync", async () => {
  const sample = fixture("B0013LAQS6");
  const label = retainedLabel(sample);
  const prior = reader(sample, label);
  const controller = new AbortController();
  const cancelled = new Error("cancelled by owner");
  prior.read.mockImplementation(async (key) => {
    if (key === label.enrichment.subject.titleEvidence?.sourceId) {
      return label.bytes;
    }
    controller.abort(cancelled);
    throw cancelled;
  });
  await expect(prior.service.read({ channel: "amazon", limit: 1 }, controller.signal)).rejects.toBe(
    cancelled,
  );
  expect(prior.log.warn).not.toHaveBeenCalled();
});
