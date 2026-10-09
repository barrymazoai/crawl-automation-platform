import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { operationRequestId } from "./product-attempt.js";
import { productFixture } from "./testing/product-fixture.js";
import { signal } from "./testing/fakes.js";

it.each([1, 2, 3])(
  "keeps independent analysis, apply and delivery receipts for attempt %s",
  async (attempt) => {
    const test = await productFixture();
    const { runId } = test;
    const suffix = attempt === 1 ? "" : `@${attempt}`;
    if (attempt > 1) {
      test.steps.set(`${runId}/products`, { captured: 99 });
      test.steps.set(`${runId}/product-analysis`, { analysisId: randomUUID() });
      test.steps.set(`${runId}/product-sources`, {
        created: [],
        matched: [],
        skipped: [],
        tasks: [],
      });
    }
    test.progress.products.running = 0;
    await test.service.tick(runId, signal, attempt);
    expect(test.create).toHaveBeenCalledWith(
      {
        requestId: attempt === 1 ? runId : operationRequestId(runId, `analyze@${attempt}`),
        url: "https://example.test",
      },
      test.analysis.limits,
    );
    expect(test.apply).toHaveBeenCalledWith({
      requestId: operationRequestId(runId, `apply${suffix}`),
      analysisId: test.analysis.analysisId,
      enqueue: true,
    });
    expect(await test.runs.step(runId, `product-analysis${suffix}`)).toEqual({
      analysisId: test.analysis.analysisId,
    });
    expect(await test.runs.step(runId, `product-sources${suffix}`)).toMatchObject({
      tasks: [test.task],
    });
    expect(await test.runs.step(runId, `products${suffix}`)).toMatchObject({ captured: 2 });
    if (attempt > 1) {
      expect(await test.runs.step(runId, "products")).toEqual({ captured: 99 });
    }
    await test.service.tick(runId, signal, attempt);
    expect(test.create).toHaveBeenCalledOnce();
    expect(test.apply).toHaveBeenCalledOnce();
    expect(test.delivery.deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ingestRunId: `brand-enrichment-${runId}` }),
      signal,
    );
    await test.service.stop(runId, attempt);
    expect(test.execution.stop).toHaveBeenCalledWith({
      analysisId: test.analysis.analysisId,
      scanIds: [test.task.scanId],
    });
  },
);

it("records skipped analysis outcomes in the retry without overwriting the first attempt", async () => {
  const test = await productFixture();
  test.analysis.state = "skipped";
  await test.service.tick(test.runId, signal, 2);
  expect(await test.runs.step(test.runId, "products@2")).toMatchObject({ state: "skipped" });
  expect(await test.runs.step(test.runId, "products")).toBeNull();
});
