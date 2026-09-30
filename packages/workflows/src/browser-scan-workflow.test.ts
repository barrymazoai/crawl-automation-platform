import { expect, it, vi } from "vitest";

const scan = vi.hoisted(() => vi.fn(async (input: unknown) => input));
vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => ({ scanBrandInBrowser: scan }),
  workflowInfo: () => ({ taskQueue: "browser" }),
}));

import { BrowserScanInputSchema, BrowserScanWorkflow } from "./browser-scan-workflow.js";

const input = { channel: "wholefoods", scanId: "scan", sourceUrl: "https://example.com/brand" };

it("keeps the old activity payload exactly when capture is absent", async () => {
  expect(BrowserScanInputSchema.parse(input)).toEqual(input);
  expect(await BrowserScanWorkflow(input)).toEqual(input);
});

it.each(["dtc", "gnc", "amazon", "wholefoods", "swanson", "costco"])(
  "passes an explicit browser capability for %s",
  async (channel) => {
    const request = { ...input, channel, capture: "browser" };
    expect(await BrowserScanWorkflow(request)).toEqual(request);
  },
);

it("refuses HTTP on the browser-only workflow", () => {
  expect(() => BrowserScanInputSchema.parse({ ...input, capture: "http" })).toThrow();
});

it("preserves the DTC database source ID with its catalog through the scan activity", async () => {
  const request = { ...input, channel: "dtc", sourceId: "22222222-2222-4222-8222-222222222222" };
  expect(await BrowserScanWorkflow(request)).toEqual(request);
});
