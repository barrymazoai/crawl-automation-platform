import type { ListingSighting, ProductCaptureResult } from "@crawl-automation/channels-core";
import { describe, expect, it, vi } from "vitest";
import type { ListingObservation } from "../listings/listing-model.js";
import { PipelineCapture } from "./pipeline-capture.js";

const request = {
  runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
  channel: "swanson" as const,
  url: "https://www.swansonvitamins.com/p/old-handle",
  brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  operationId: "pipeline-1",
};
const signal = () => AbortSignal.timeout(5_000);

function captureAnswering(result: ProductCaptureResult) {
  const recorded: unknown[] = [];
  const listings = {
    record: vi.fn(async (raw: unknown) => {
      recorded.push(raw);
      return { observationId: "b".repeat(64) } as ListingObservation;
    }),
  };
  const capture = { capture: vi.fn(async () => result) };
  return { recorded, listings, pipeline: new PipelineCapture({ capture, listings }) };
}

const sighted = (sighting: ListingSighting): ProductCaptureResult => ({
  status: "sighted",
  listingId: "old-handle",
  variantId: null,
  sighting,
});

describe("PipelineCapture", () => {
  it("ends a gone listing as a recorded sighting, not a Review", async () => {
    const { recorded, pipeline } = captureAnswering(
      sighted({
        state: "gone",
        causeCode: "CAPTURE.NOT_FOUND",
        httpStatus: 404,
        observedListingId: null,
        archiveKey: null,
      }),
    );
    expect(await pipeline.capture(request, signal())).toEqual({
      status: "listing",
      state: "gone",
      operationId: "pipeline-1",
      observationId: "b".repeat(64),
      listingId: "old-handle",
      variantId: null,
      causeCode: "CAPTURE.NOT_FOUND",
    });
    expect(recorded[0]).toMatchObject({
      channel: "swanson",
      brandId: request.brandId,
      runId: request.runId,
      state: "gone",
      evidence: { probe: "direct-revisit", httpStatus: 404, observedExternalId: null },
      source: "crawler-v3:product-run:pipeline-1",
    });
  });

  it("records a superseded listing with the listing its page belongs to now", async () => {
    const { recorded, pipeline } = captureAnswering(
      sighted({
        state: "superseded",
        causeCode: "LISTING.SUPERSEDED",
        httpStatus: 200,
        observedListingId: "new-handle",
        archiveKey: "v3/swanson-html/pipeline-1/original.html",
      }),
    );
    expect(await pipeline.capture(request, signal())).toMatchObject({
      status: "listing",
      state: "superseded",
    });
    expect(recorded[0]).toMatchObject({
      evidence: {
        observedExternalId: "new-handle",
        artifactKey: "v3/swanson-html/pipeline-1/original.html",
      },
    });
  });

  it("passes a readable product page on unchanged and records nothing", async () => {
    const page = {
      status: "captured",
      sourcePlan: {},
      factsComplete: true,
    } as ProductCaptureResult;
    const { listings, pipeline } = captureAnswering(page);
    expect(await pipeline.capture(request, signal())).toBe(page);
    expect(listings.record).not.toHaveBeenCalled();
  });
});
