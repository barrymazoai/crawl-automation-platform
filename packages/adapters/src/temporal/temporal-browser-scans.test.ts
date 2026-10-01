import * as platform from "@crawl-automation/platform";
import type { Client } from "@temporalio/client";
import { expect, it, vi } from "vitest";
import { TemporalBrowserScans } from "./temporal-browser-scans.js";

it("routes the configured browser permit and preserves throttling as the Review reason", async () => {
  const failure = Object.assign(new Error("workflow failed"), {
    cause: { cause: { type: "WHOLEFOODS.SEARCH_THROTTLED" } },
  });
  const start = vi.fn(async () => ({
    result: async () => {
      throw failure;
    },
    cancel: vi.fn(),
  }));
  const client = { workflow: { start } } as unknown as Client;
  const scans = new TemporalBrowserScans(client, "browser", {
    wholefoods: {
      taskQueue: "wholefoods-browser",
      resourceQueue: "resources",
      resourceId: "wholefoods-brand-scan",
      gapAfterSeconds: 60,
      cooldownSeconds: 1800,
      maxWaitSeconds: 900,
    },
  });
  const request = {
    channel: "wholefoods" as const,
    scanId: "scan-1",
    sourceUrl: "https://example.com/brand",
  };
  await expect(scans.scan(request, new AbortController().signal)).rejects.toMatchObject({
    code: "WHOLEFOODS.SEARCH_THROTTLED",
  });
  expect(start).toHaveBeenCalledExactlyOnceWith(
    "BrowserScanWorkflow",
    expect.objectContaining({
      taskQueue: "wholefoods-browser",
      args: [
        {
          ...request,
          capture: "browser",
          gapAfterSeconds: 60,
          cooldownSeconds: 1800,
          resources: {
            queue: "resources",
            maxWaitSeconds: 900,
            activities: { scanBrandInBrowser: [{ resourceId: "wholefoods-brand-scan", units: 1 }] },
          },
        },
      ],
    }),
  );
  expect(start).not.toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      workflowExecutionTimeout: expect.anything(),
    }),
  );
});

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
