import type { ListingScan } from "@crawl-automation/app";
import { WorkflowExecutionAlreadyStartedError, type Client } from "@temporalio/client";
import { expect, it, vi } from "vitest";
import { TemporalBrandListings } from "./temporal-brand-listings.js";

const scan: ListingScan = {
  scanId: "11111111-1111-4111-8111-111111111111",
  source: {
    sourceId: "22222222-2222-4222-8222-222222222222",
    channel: "swanson",
    url: "https://example.com",
    brandName: "Allimax",
  },
};
const settings = {
  taskQueue: "pipeline",
  resourceQueue: "resources",
  resourceId: "swanson-brand-scan",
  maxWaitSeconds: 900,
  gapAfterSeconds: 30,
};

function fixture() {
  const result = {
    pages: [],
    products: [],
    full: true,
    credits: 0,
    families: 0,
    unresolvedFamilies: 0,
  };
  const handle = { result: vi.fn(async () => result), cancel: vi.fn(async () => undefined) };
  const start = vi.fn(async () => handle);
  const getHandle = vi.fn(() => handle);
  const client = { workflow: { start, getHandle } } as unknown as Client;
  return { scans: new TemporalBrandListings(client, settings), start, handle, result, getHandle };
}

it("starts one durable gated listing for the scan snapshot", async () => {
  const test = fixture();
  await expect(test.scans.read(scan, new AbortController().signal)).resolves.toEqual(test.result);
  expect(test.start).toHaveBeenCalledExactlyOnceWith("BrandListingWorkflow", {
    workflowId: `brand-listing-${scan.scanId}`,
    taskQueue: "pipeline",
    args: [
      {
        ...scan,
        gapAfterSeconds: 30,
        resources: {
          queue: "resources",
          maxWaitSeconds: 900,
          activities: { readBrandListing: [{ resourceId: "swanson-brand-scan", units: 1 }] },
        },
      },
    ],
    workflowIdReusePolicy: "REJECT_DUPLICATE",
    workflowIdConflictPolicy: "USE_EXISTING",
  });
});

it.each(["RESOURCE.WAIT_LIMIT", "BRAND_SCAN.ACCESS_CHALLENGE"])(
  "carries %s through Temporal wrappers to the runner without a second start",
  async (code) => {
    const test = fixture();
    const failure = Object.assign(new Error("workflow failed"), {
      cause: { cause: { type: code } },
    });
    test.handle.result.mockRejectedValueOnce(failure);
    await expect(test.scans.read(scan, new AbortController().signal)).rejects.toMatchObject({
      code,
    });
    expect(test.start).toHaveBeenCalledOnce();
  },
);

it("reattaches to a closed workflow instead of repeating a finished or failed paid scan", async () => {
  const test = fixture();
  test.start.mockRejectedValueOnce(
    new WorkflowExecutionAlreadyStartedError(
      "already finished",
      `brand-listing-${scan.scanId}`,
      "BrandListingWorkflow",
    ),
  );
  await expect(test.scans.read(scan, new AbortController().signal)).resolves.toEqual(test.result);
  expect(test.getHandle).toHaveBeenCalledExactlyOnceWith(`brand-listing-${scan.scanId}`);
  expect(test.start).toHaveBeenCalledOnce();
});

it("propagates cancellation even when it arrives during start", async () => {
  const test = fixture();
  const controller = new AbortController();
  test.start.mockImplementationOnce(async () => {
    controller.abort();
    return test.handle;
  });
  await test.scans.read(scan, controller.signal);
  expect(test.handle.cancel).toHaveBeenCalledOnce();
});

it("does not start after cancellation", async () => {
  const test = fixture();
  await expect(test.scans.read(scan, AbortSignal.abort())).rejects.toThrow();
  expect(test.start).not.toHaveBeenCalled();
});
