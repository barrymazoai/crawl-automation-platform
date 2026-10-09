import { expect, it } from "vitest";
import { signal } from "./testing/fakes.js";
import { productFixture as fixture } from "./testing/product-fixture.js";

it("waits for the brand's queued products, then delivers its sources once while retaining Reviews", async () => {
  const test = await fixture();
  expect(await test.service.tick(test.runId, signal)).toEqual({ done: false });
  expect(test.delivery.deliver).not.toHaveBeenCalled();
  test.progress.products.running = 0;
  test.progress.products.completed = 2;
  expect(await test.service.tick(test.runId, signal)).toEqual({ done: true });
  expect(test.apply).toHaveBeenCalledOnce();
  expect(test.delivery.deliver).toHaveBeenCalledWith(
    {
      companyId: test.companyId,
      siteKey: "example.test",
      sourceIds: [test.task.sourceId],
      ingestRunId: `brand-enrichment-${test.runId}`,
    },
    signal,
  );
  await test.service.tick(test.runId, signal);
  expect(test.delivery.deliver).toHaveBeenCalledOnce();
  expect(await test.runs.step(test.runId, "products")).toMatchObject({
    captured: 2,
    review: 1,
    refused: [{ externalId: "one", reason: "duplicate" }],
  });
});
it("a not-nutrition analysis never applies or delivers products", async () => {
  const test = await fixture();
  test.analysis.state = "skipped";
  await test.service.tick(test.runId, signal);
  expect(test.apply).not.toHaveBeenCalled();
  expect(test.delivery.deliver).not.toHaveBeenCalled();
});
it("cancellation passes only the recorded analysis and its exact scans to execution cleanup", async () => {
  const test = await fixture();
  await test.service.tick(test.runId, signal);
  await test.service.stop(test.runId);
  expect(test.execution.stop).toHaveBeenCalledWith({
    analysisId: test.analysis.analysisId,
    scanIds: [test.task.scanId],
  });
});
