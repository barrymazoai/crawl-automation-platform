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
  it("ends a missing page as an unlisted sighting (not found), not a Review", async () => {
    const { recorded, pipeline } = captureAnswering(
      sighted({
        state: "unlisted",
        reason: "not_found",
        causeCode: "LISTING.NOT_FOUND",
        httpStatus: 404,
        observedListingId: null,
        finalUrl: null,
        archiveKey: null,
      }),
    );
    expect(await pipeline.capture(request, signal())).toEqual({
      status: "listing",
      state: "unlisted",
      reason: "not_found",
      operationId: "pipeline-1",
      observationId: "b".repeat(64),
      listingId: "old-handle",
      variantId: null,
      causeCode: "LISTING.NOT_FOUND",
    });
    expect(recorded[0]).toMatchObject({
      channel: "swanson",
      brandId: request.brandId,
      runId: request.runId,
      state: "unlisted",
      reason: "not_found",
      evidence: { probe: "direct-revisit", httpStatus: 404, observedExternalId: null },
      source: "crawler-v3:product-run:pipeline-1",
    });
  });

  it("records a redirect to a different product as unlisted, naming that product and where it landed", async () => {
    const landed = "https://www.swansonvitamins.com/p/new-handle";
    const { recorded, pipeline } = captureAnswering(
      sighted({
        state: "unlisted",
        reason: "redirected_to_other_product",
        causeCode: "LISTING.REDIRECTED_TO_OTHER_PRODUCT",
        httpStatus: 200,
        observedListingId: "new-handle",
        finalUrl: landed,
        archiveKey: "v3/swanson-html/pipeline-1/original.html",
      }),
    );
    expect(await pipeline.capture(request, signal())).toMatchObject({
      status: "listing",
      state: "unlisted",
      reason: "redirected_to_other_product",
    });
    expect(recorded[0]).toMatchObject({
      reason: "redirected_to_other_product",
      evidence: {
        observedExternalId: "new-handle",
        finalUrl: landed,
        artifactKey: "v3/swanson-html/pipeline-1/original.html",
      },
    });
  });

  it("passes a readable product page on without its page record, and records no sighting", async () => {
    const page = {
      status: "captured",
      sourcePlan: {},
      factsComplete: true,
    } as ProductCaptureResult;
    const { listings, pipeline } = captureAnswering(page);
    expect(await pipeline.capture(request, signal())).toEqual(page);
    expect(listings.record).not.toHaveBeenCalled();
  });

  it("records one metrics point for a captured page and hands the workflow the capture without it", async () => {
    const shown = { channel: "swanson", archive: { objectKey: "k", sha256: "a".repeat(64) } };
    const captured = { status: "captured", factsComplete: true, page: shown };
    const history = { record: vi.fn(async () => ({ inserted: true })) };
    const pipeline = new PipelineCapture({
      capture: { capture: vi.fn(async () => captured as unknown as ProductCaptureResult) },
      listings: { record: vi.fn() },
      history,
    });
    expect(await pipeline.capture(request, signal())).toEqual({
      status: "captured",
      factsComplete: true,
    });
    expect(history.record).toHaveBeenCalledWith(shown, {
      runId: request.runId,
      operationId: request.operationId,
      brandId: request.brandId,
      sourceId: request.sourceId,
    });
  });

  it("a metrics point that cannot be stored never fails the capture; it is reported as pending", async () => {
    const shown = { channel: "swanson", archive: { objectKey: "k", sha256: "a".repeat(64) } };
    const captured = { status: "captured", page: shown };
    const failure = new Error("database unreachable");
    const onHistoryPending = vi.fn();
    const pipeline = new PipelineCapture({
      capture: { capture: vi.fn(async () => captured as unknown as ProductCaptureResult) },
      listings: { record: vi.fn() },
      history: { record: vi.fn(async () => Promise.reject(failure)) },
      onHistoryPending,
    });
    expect(await pipeline.capture(request, signal())).toEqual({ status: "captured" });
    expect(onHistoryPending).toHaveBeenCalledWith(failure, shown);
  });
});
