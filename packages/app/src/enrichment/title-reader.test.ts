import { expect, it, vi } from "vitest";
import { swansonPipelineFixture } from "@crawl-automation/channel-swanson";
import type { ChannelRegistry } from "@crawl-automation/channels-core";
import type { ArtifactResolver } from "@crawl-automation/platform";
import { EnrichmentTitleReader } from "./title-reader.js";

async function setup() {
  const { sourcePlan } = await swansonPipelineFixture(AbortSignal.timeout(5000));
  const subject = {
    channel: "swanson" as const,
    listingId: sourcePlan.owner.listingId,
    variantId: sourcePlan.owner.variantId,
    title: "Old history title",
    titleEvidence: null,
    collectionOperationId: "label",
    observation: sourcePlan.owner,
  };
  const request = { channel: "swanson" as const, collectionOperationId: "label", sourcePlan };
  const read = vi.fn(() => ({ evidence: { title: "Selected product title" } }));
  const registry = { get: () => ({ planning: { read } }) } as unknown as ChannelRegistry;
  const resolve = vi.fn(async () => ({ bytes: Buffer.from('{"retained":true}') }));
  const artifacts = { resolve } as unknown as ArtifactResolver;
  return {
    request,
    subject,
    resolve,
    read,
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
