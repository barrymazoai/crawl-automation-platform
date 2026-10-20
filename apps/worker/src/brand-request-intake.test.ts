import { expect, it, vi } from "vitest";
import type { IntakeOutcome } from "@crawl-automation/app";
import { listenLoop } from "./brand-request-intake.js";
import { BrandEnrichmentSettingsSchema } from "./brand-enrichment-settings.js";

function scripted(outcomes: Array<IntakeOutcome | Error>, controller: AbortController) {
  return vi.fn(async () => {
    const next = outcomes.shift();
    if (!next) {
      controller.abort();
      return "idle" as const;
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
}

it("polls again at once after an idle or claimed round, and waits while busy", async () => {
  const controller = new AbortController();
  const listen = scripted(["idle", "claimed", "busy", "stuck", "idle"], controller);
  const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
  await listenLoop({
    listen,
    log: { warn: vi.fn() },
    busyMs: 15_000,
    signal: controller.signal,
    sleep,
  });
  expect(listen).toHaveBeenCalledTimes(6);
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([15_000, 60_000]);
});

it("backs off 5 s, 10 s, … up to a minute on failures, and resets after a good round", async () => {
  const controller = new AbortController();
  const log = { warn: vi.fn() };
  const failures = Array.from({ length: 6 }, () => new Error("404"));
  const listen = scripted([...failures, "idle", new Error("404")], controller);
  const sleep = vi.fn(async (_ms: number, _signal: AbortSignal) => {});
  await listenLoop({ listen, log, busyMs: 15_000, signal: controller.signal, sleep });
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
    5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 5_000,
  ]);
  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({ retryInMs: 5_000 }),
    "brand request long poll failed",
  );
});

it("stops when the worker shuts down mid-wait", async () => {
  const controller = new AbortController();
  const listen = vi.fn(async () => "busy" as const);
  const done = listenLoop({
    listen,
    log: { warn: vi.fn() },
    busyMs: 60_000,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await expect(done).resolves.toBeUndefined();
});

it("request intake defaults: on, one run at a time, 25 s polls, 15 min fallback, 2 h timeout", () => {
  const settings = BrandEnrichmentSettingsSchema.shape.requestIntake.parse(undefined);
  expect(settings).toEqual({
    enabled: true,
    maxLiveRuns: 1,
    waitSeconds: 25,
    busySeconds: 15,
    fallbackMinutes: 15,
    timeoutMinutes: 120,
  });
  expect(
    BrandEnrichmentSettingsSchema.shape.requestIntake.safeParse({ webhookFile: "feishu.webhook" })
      .success,
  ).toBe(false);
});
