import { expect, it, vi } from "vitest";
import { swansonPipelineFixture } from "@crawl-automation/channel-swanson";
import type { ChannelRegistry } from "@crawl-automation/channels-core";
import type { ArtifactResolver } from "@crawl-automation/platform";
import { EnrichmentTitleReader } from "./title-reader.js";

async function setup(channel: "swanson" | "dtc" = "swanson") {
  const { sourcePlan } = await swansonPipelineFixture(AbortSignal.timeout(5000));
  sourcePlan.channel = channel;
  if (channel === "dtc") {
    sourcePlan.owner.variantId = null;
  }
  const subject = {
    channel,
    listingId: sourcePlan.owner.listingId,
    variantId: sourcePlan.owner.variantId,
    title: "Old history title",
    titleEvidence: null,
    collectionOperationId: "label",
    observation: sourcePlan.owner,
  };
  const request = { channel, collectionOperationId: "label", sourcePlan };
  const variant = {
    listingId: subject.listingId,
    variantId: "one",
    title: "100 ct",
    url: sourcePlan.expectedUrl,
  };
  const product = {
    evidence: {
      title: "Selected product title",
      variantOptions: ["VegCaps: 100 ct"],
      variants: [variant],
    },
  };
  const read = vi.fn(() => product);
  const registry = { get: () => ({ planning: { read } }) } as unknown as ChannelRegistry;
  const resolve = vi.fn(async () => ({ bytes: Buffer.from('{"retained":true}') }));
  const artifacts = { resolve } as unknown as ArtifactResolver;
  return {
    request,
    subject,
    resolve,
    read,
    product,
    variant,
    reader: new EnrichmentTitleReader(registry, artifacts),
  };
}
it("reads the selected projection with hash/owner verification through the existing channel decoder", async () => {
  const state = await setup();
  const signal = AbortSignal.timeout(5000);
  const result = await state.reader.read(state.request, state.subject, signal);
  expect(result.title).toBe("Selected product title");
  expect(state.resolve).toHaveBeenCalledWith(
    state.request.sourcePlan.source,
    state.request.sourcePlan.owner,
    signal,
  );
  expect(state.read).toHaveBeenCalledWith(
    { retained: true },
    state.request.sourcePlan.expectedUrl,
    state.request.sourcePlan.owner,
  );
  expect(result.titleEvidence?.sha256).toBe(state.request.sourcePlan.source.sha256);
});

it("preserves the sole DTC website variant with verified projection provenance", async () => {
  const state = await setup("dtc");
  const result = await state.reader.read(state.request, state.subject, AbortSignal.timeout(5000));
  expect(result.title).toBe("Selected product title");
  expect(result.websiteVariant).toEqual({
    protocol: "website-variant/1",
    variantId: "one",
    title: "100 ct",
    options: ["VegCaps: 100 ct"],
    evidence: {
      sourceId: state.request.sourcePlan.source.objectKey,
      sha256: state.request.sourcePlan.source.sha256,
    },
  });
});

it("does not assign a default website variant to a multi-variant base product", async () => {
  const state = await setup("dtc");
  state.product.evidence.variants.push({
    ...state.variant,
    variantId: "two",
    title: "200 ct",
  });
  expect(
    (await state.reader.read(state.request, state.subject, AbortSignal.timeout(5000)))
      .websiteVariant,
  ).toBeUndefined();
  state.request.sourcePlan.owner.variantId = "one";
  state.subject.variantId = "one";
  expect(
    (await state.reader.read(state.request, state.subject, AbortSignal.timeout(5000)))
      .websiteVariant?.title,
  ).toBe("100 ct");
});

it("does not take a sibling listing's variant or extend non-DTC behavior", async () => {
  const state = await setup("dtc");
  state.variant.listingId = "sibling";
  expect(
    (await state.reader.read(state.request, state.subject, AbortSignal.timeout(5000)))
      .websiteVariant,
  ).toBeUndefined();
  const other = await setup();
  expect(
    (await other.reader.read(other.request, other.subject, AbortSignal.timeout(5000)))
      .websiteVariant,
  ).toBeUndefined();
});
it("refuses a sibling projection's title before reading bytes", async () => {
  const state = await setup();
  await expect(
    state.reader.read(
      state.request,
      { ...state.subject, listingId: "other" },
      AbortSignal.timeout(5000),
    ),
  ).rejects.toMatchObject({ code: "ENRICH.INTEGRITY" });
  expect(state.resolve).not.toHaveBeenCalled();
});
