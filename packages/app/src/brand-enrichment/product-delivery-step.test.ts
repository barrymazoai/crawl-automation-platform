import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { BrandProductRedelivery } from "./product-redelivery.js";
import { deliverBrandProducts } from "./product-delivery-step.js";
import { productFixture } from "./testing/product-fixture.js";
import { signal } from "./testing/fakes.js";
import { requireRun } from "./run-records.js";

it.each([1, 2])(
  "uses the verified store domain for products attempt %i and redelivery",
  async (attempt) => {
    const test = await productFixture();
    test.records.set(test.runId, {
      ...(await requireRun(test.runs, test.runId)),
      brandUrl: "https://sambucol.com/",
    });
    test.progress.catalogUrl = "https://sambucolusa.com/collections/shop-all";
    test.progress.products.running = 0;
    await test.service.tick(test.runId, signal, attempt);
    await test.runs.update(test.runId, { state: "completed" });
    await new BrandProductRedelivery(test).deliver(test.runId, signal);
    expect(test.delivery.catalogs).toHaveBeenCalledWith([test.task.sourceId], signal);
    expect(test.delivery.deliver).toHaveBeenCalledTimes(2);
    for (const [request] of test.delivery.deliver.mock.calls) {
      expect(request).toEqual({
        companyId: test.companyId,
        siteKey: "sambucolusa.com",
        sourceIds: [test.task.sourceId],
        ingestRunId: `brand-enrichment-${test.runId}`,
      });
    }
  },
);

it("groups sources by catalog domain with stable distinct ingest runs and summed results", async () => {
  const test = await productFixture();
  const second = { ...test.task, sourceId: randomUUID(), scanId: randomUUID() };
  const third = { ...test.task, sourceId: randomUUID(), scanId: randomUUID() };
  const catalogs = [
    { sourceId: test.task.sourceId, catalogUrl: "https://sambucolusa.com/collections/shop-all" },
    { sourceId: second.sourceId, catalogUrl: "https://www.sambucolusa.com/collections/kids" },
    { sourceId: third.sourceId, catalogUrl: "https://zahlers.com/collections/example" },
  ];
  test.delivery.catalogs.mockResolvedValue(catalogs);
  const input = {
    runId: test.runId,
    companyId: test.companyId,
    applied: { created: [], matched: [], skipped: [], tasks: [third, test.task, second, third] },
  };
  expect(await deliverBrandProducts(test.delivery, input, signal)).toMatchObject({
    captured: 4,
    review: 2,
    delivered: 2,
    refused: [
      { externalId: "one", reason: "duplicate" },
      { externalId: "one", reason: "duplicate" },
    ],
  });
  const requests = test.delivery.deliver.mock.calls.map(([request]) => request);
  expect(requests).toEqual([
    {
      companyId: test.companyId,
      siteKey: "sambucolusa.com",
      sourceIds: [test.task.sourceId, second.sourceId].sort(),
      ingestRunId: `brand-enrichment-${test.runId}-sambucolusa.com`,
    },
    {
      companyId: test.companyId,
      siteKey: "zahlers.com",
      sourceIds: [third.sourceId],
      ingestRunId: `brand-enrichment-${test.runId}-zahlers.com`,
    },
  ]);
  input.applied.tasks.reverse();
  test.delivery.catalogs.mockResolvedValue([...catalogs].reverse());
  await deliverBrandProducts(test.delivery, input, signal);
  expect(test.delivery.deliver.mock.calls.slice(2).map(([request]) => request)).toEqual(requests);
});

it.each(["missing", "invalid", "ambiguous"])(
  "refuses a %s source catalog before sending anything",
  async (kind) => {
    const test = await productFixture();
    const catalog = { sourceId: test.task.sourceId, catalogUrl: "https://sambucolusa.com/all" };
    const catalogs =
      kind === "missing"
        ? []
        : kind === "ambiguous"
          ? [catalog, catalog]
          : [{ ...catalog, catalogUrl: "https://" }];
    test.delivery.catalogs.mockResolvedValue(catalogs);
    test.progress.products.running = 0;
    await expect(test.service.tick(test.runId, signal)).rejects.toMatchObject({
      code: "BRAND_ENRICHMENT.IDENTITY_UNRESOLVED",
    });
    expect(test.delivery.deliver).not.toHaveBeenCalled();
  },
);
