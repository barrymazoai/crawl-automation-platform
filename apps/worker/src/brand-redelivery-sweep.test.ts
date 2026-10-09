import { afterEach, expect, it, vi } from "vitest";
import { setTimeout } from "node:timers/promises";
import { createLogger } from "@crawl-automation/platform";
import { brandRedeliverySweepLoop, runBrandRedeliverySweep } from "./brand-redelivery-sweep.js";
import type { WorkerParts } from "./container.js";

vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>();
  return { ...actual, setTimeout: vi.fn(actual.setTimeout) };
});
afterEach(() => vi.mocked(setTimeout).mockReset());

function fixture() {
  const controller = new AbortController();
  const log = createLogger({ name: "test", level: "fatal" });
  return {
    controller,
    signal: controller.signal,
    log,
    sweep: vi.fn<() => Promise<void>>(async () => undefined),
  };
}

it("does not initialize brand services when unconfigured or disabled", async () => {
  const getServices = vi.fn();
  for (const brandEnrichment of [undefined, { limits: { redeliverySweepMinutes: 0 } }]) {
    const parts = {
      config: { brandEnrichment },
      get brandEnrichment() {
        return getServices();
      },
    } as unknown as WorkerParts;
    await runBrandRedeliverySweep(parts, new AbortController().signal);
  }
  expect(getServices).not.toHaveBeenCalled();
});

it("does not start a disabled or aborted loop", async () => {
  const test = fixture();
  await brandRedeliverySweepLoop({ ...test, intervalMs: 0 });
  test.controller.abort();
  await brandRedeliverySweepLoop({ ...test, intervalMs: 1 });
  expect(test.sweep).not.toHaveBeenCalled();
});

it("logs query failures, continues next interval, and stops on abort", async () => {
  const test = fixture();
  const error = new Error("database unavailable");
  const warn = vi.spyOn(test.log, "warn");
  test.sweep
    .mockRejectedValueOnce(error)
    .mockImplementationOnce(async () => test.controller.abort());
  await brandRedeliverySweepLoop({ ...test, intervalMs: 1 });
  expect(test.sweep).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledWith({ err: error }, "brand redelivery sweep failed");
});

it("uses the configured minutes and waits for a sweep before scheduling the next", async () => {
  const test = fixture();
  let finish: () => void = () => undefined;
  test.sweep.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const parts = {
    config: { brandEnrichment: { limits: { redeliverySweepMinutes: 2 } } },
    brandEnrichment: Promise.resolve({ redeliverySweep: { sweep: test.sweep } }),
    log: test.log,
  } as unknown as WorkerParts;
  const running = runBrandRedeliverySweep(parts, test.signal);
  await vi.waitFor(() => expect(test.sweep).toHaveBeenCalledOnce());
  expect(setTimeout).not.toHaveBeenCalled();
  vi.mocked(setTimeout).mockImplementationOnce(async () => undefined);
  test.sweep.mockImplementationOnce(async () => test.controller.abort());
  expect(test.sweep).toHaveBeenCalledOnce();
  finish();
  await running;
  expect(test.sweep).toHaveBeenCalledTimes(2);
  expect(setTimeout).toHaveBeenCalledWith(120_000, undefined, { signal: test.signal });
});

it("interrupts the timer on shutdown", async () => {
  const test = fixture();
  const running = brandRedeliverySweepLoop({ ...test, intervalMs: 60_000 });
  await vi.waitFor(() => expect(setTimeout).toHaveBeenCalledOnce());
  test.controller.abort();
  await running;
  expect(test.sweep).toHaveBeenCalledOnce();
});

it("treats abort during delivery as normal shutdown", async () => {
  const test = fixture();
  const warn = vi.spyOn(test.log, "warn");
  test.sweep.mockImplementationOnce(async () => {
    test.controller.abort();
    test.signal.throwIfAborted();
  });
  await brandRedeliverySweepLoop({ ...test, intervalMs: 1 });
  expect(warn).not.toHaveBeenCalled();
});
