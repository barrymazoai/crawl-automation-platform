import * as platform from "@crawl-automation/platform";
import type { Client } from "@temporalio/client";
import { expect, it, vi } from "vitest";
import { TemporalBrowserScans } from "./temporal-browser-scans.js";

it.each(["wholefoods", "dtc", "amazon"] as const)(
  "starts a browser-capable scan for %s with an explicit capability",
  async (channel) => {
    const result = { pages: [], complete: true, soldHere: true, archiveKeys: [] };
    const handle = { result: vi.fn(async () => result), cancel: vi.fn() };
    const start = vi.fn(async () => handle);
    const client = { workflow: { start } } as unknown as Client;
    const scans = new TemporalBrowserScans(client, "browser-queue");
    const request = { channel, scanId: "scan-1", sourceUrl: "https://example.com/brand" };
    expect(await scans.scan(request, new AbortController().signal)).toEqual(result);
    expect(start).toHaveBeenCalledWith(
      "BrowserScanWorkflow",
      expect.objectContaining({
        args: [{ ...request, capture: "browser" }],
        taskQueue: "browser-queue",
        workflowIdReusePolicy: "REJECT_DUPLICATE",
        workflowIdConflictPolicy: "USE_EXISTING",
      }),
    );
  },
);

it("records the actual cancellation failure without changing the scan result", async () => {
  const controller = new AbortController();
  const failure = new Error("Temporal transport disconnected");
  const recorded = vi.spyOn(platform, "recordRecovery").mockImplementation(() => undefined);
  const result = { pages: [], complete: false, soldHere: true, archiveKeys: [] };
  const cancel = vi.fn(async () => {
    throw failure;
  });
  const handle = {
    cancel,
    result: async () => {
      controller.abort();
      return result;
    },
  };
  const client = { workflow: { start: async () => handle } } as unknown as Client;
  const scans = new TemporalBrowserScans(client, "browser");
  await expect(
    scans.scan(
      { channel: "dtc", scanId: "scan-1", sourceUrl: "https://example.com" },
      controller.signal,
    ),
  ).resolves.toEqual(result);
  expect(cancel).toHaveBeenCalledOnce();
  expect(recorded).toHaveBeenCalledWith(failure, {
    runId: "scan-1",
    operation: "browserScan.cancel",
  });
  recorded.mockRestore();
});
