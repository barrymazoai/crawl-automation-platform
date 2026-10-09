import { operationRequestId } from "./products-service.js";
import { expect, it } from "vitest";
import { BrandSummaryService } from "./summary-service.js";
import { family, signal } from "./testing/fakes.js";
import { productFixture } from "./testing/product-fixture.js";

const catalogUrl = "https://owner.test/collections/example";

it.each([null, true, false])(
  "selects the product entry from saved family (sameBrand=%s)",
  async (sameBrand) => {
    const test = await productFixture();
    test.steps.set(`${test.runId}/family`, {
      ...family,
      catalogUrl,
      redirect:
        sameBrand === null
          ? null
          : { fromDomain: "example.test", toDomain: "owner.test", sameBrand },
    });
    test.progress.products.running = 0;
    expect(await test.service.tick(test.runId, signal)).toEqual({ done: true });
    expect(test.create).toHaveBeenCalledWith(
      {
        requestId: test.runId,
        url: sameBrand === false ? catalogUrl : "https://example.test",
      },
      test.analysis.limits,
    );
    expect(test.apply).toHaveBeenCalledWith({
      // Analyze and apply each have their own receipt (one row per request ID).
      requestId: operationRequestId(test.runId, "apply"),
      analysisId: test.analysis.analysisId,
      enqueue: true,
      ...(sameBrand === false ? { catalogUrl } : {}),
    });
    expect(test.delivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        siteKey: sameBrand === false ? "owner.test" : "example.test",
        sourceIds: [test.task.sourceId],
      }),
      signal,
    );
    await test.service.tick(test.runId, signal);
    expect(test.create).toHaveBeenCalledOnce();
    expect(test.apply).toHaveBeenCalledOnce();
  },
);

it.each([null, undefined])(
  "skips absorbed brands without a saved catalog (%s)",
  async (catalog) => {
    const test = await productFixture();
    test.steps.set(`${test.runId}/family`, {
      ...family,
      catalogUrl: catalog,
      redirect: { fromDomain: "example.test", toDomain: "owner.test", sameBrand: false },
    });
    expect(await test.service.tick(test.runId, signal)).toEqual({ done: true });
    expect(await test.runs.step(test.runId, "products")).toEqual({
      captured: 0,
      review: 0,
      reason: "absorbed_brand_without_catalog",
    });
    expect(await new BrandSummaryService(test).build(test.runId)).toMatchObject({
      products: { captured: 0, review: 0 },
    });
    expect(test.create).not.toHaveBeenCalled();
    expect(test.apply).not.toHaveBeenCalled();
    expect(test.delivery.deliver).not.toHaveBeenCalled();
  },
);

it("retains zero products when no verified catalog can be applied", async () => {
  const test = await productFixture();
  test.steps.set(`${test.runId}/family`, {
    ...family,
    catalogUrl,
    redirect: { fromDomain: "example.test", toDomain: "owner.test", sameBrand: false },
  });
  test.progress.products.running = 0;
  test.apply.mockResolvedValue({
    created: [],
    matched: [],
    tasks: [],
    skipped: [{ name: "Owner", reason: "Outside requested catalog" }],
  });
  expect(await test.service.tick(test.runId, signal)).toEqual({ done: true });
  expect(test.delivery.deliver).not.toHaveBeenCalled();
  expect(await test.runs.step(test.runId, "products")).toMatchObject({
    captured: 0,
    review: 0,
    reason: "No verified DTC sources",
    skipped: [{ name: "Owner", reason: "Outside requested catalog" }],
  });
});
