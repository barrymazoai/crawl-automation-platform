import { afterEach, expect, it, vi } from "vitest";
import { createLogger } from "@crawl-automation/platform";
import { stopSweepLoop } from "./stop-sweep.js";
import { StopSweepSettingsSchema } from "./stop-sweep-settings.js";

afterEach(() => vi.useRealTimers());

it("defaults to 60 seconds and requires an explicit API address", () => {
  expect(StopSweepSettingsSchema.parse({ apiUrl: "http://localhost/trpc" }).intervalMs).toBe(
    60_000,
  );
  expect(StopSweepSettingsSchema.safeParse({}).success).toBe(false);
});

it("logs attempts, survives an outage, runs sequentially and stops with the process", async () => {
  const controller = new AbortController();
  const api = { verifyStops: vi.fn(async () => ({ results: [], released: [] })) };
  api.verifyStops
    .mockRejectedValueOnce(new Error("API offline"))
    .mockImplementationOnce(async () => {
      controller.abort();
      return { results: [], released: [] };
    });
  const log = createLogger({ name: "sweep", level: "fatal" });
  const warn = vi.spyOn(log, "warn");
  const info = vi.spyOn(log, "info");
  await stopSweepLoop({ api, log, intervalMs: 1, signal: controller.signal });
  expect(api.verifyStops).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledOnce();
  expect(info).toHaveBeenCalledTimes(3);
});
