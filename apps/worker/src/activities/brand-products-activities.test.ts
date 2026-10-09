import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { WorkerParts } from "../container.js";
import { brandProductsActivities } from "./brand-products-activities.js";

const signal = vi.hoisted(() => new AbortController().signal);
vi.mock("./activity-guard.js", () => ({
  guarded:
    (_name: string, handler: (raw: unknown, signal: AbortSignal) => Promise<unknown>) =>
    (raw: unknown) =>
      handler(raw, signal),
}));

function fixture() {
  const services = { products: { tick: vi.fn(), stop: vi.fn() }, runs: { saveStep: vi.fn() } };
  const parts = { brandEnrichment: Promise.resolve(services), log: {} } as unknown as WorkerParts;
  return { services, activities: brandProductsActivities(parts), runId: randomUUID() };
}

it.each([undefined, 1, 2, 3])(
  "routes product activity scope and failure evidence for attempt %s",
  async (attempt) => {
    const test = fixture();
    const input = { runId: test.runId, ...(attempt === undefined ? {} : { attempt }) };
    await test.activities.brandProducts(input);
    expect(test.services.products.tick).toHaveBeenCalledWith(test.runId, signal, attempt);
    await test.activities.brandProductsStop(input);
    expect(test.services.products.stop).toHaveBeenCalledWith(test.runId, attempt);
    await test.activities.brandProductFailure({ ...input, reason: "failed" });
    expect(test.services.runs.saveStep).toHaveBeenCalledWith({
      runId: test.runId,
      step: (attempt ?? 1) === 1 ? "products-failure" : `products-failure@${attempt}`,
      output: { reason: "failed" },
      archiveKeys: [],
    });
  },
);

it.each([0, -1, 1.5])("rejects invalid attempt %s before running products", async (attempt) => {
  const test = fixture();
  await expect(test.activities.brandProducts({ runId: test.runId, attempt })).rejects.toThrow();
  expect(test.services.products.tick).not.toHaveBeenCalled();
});
