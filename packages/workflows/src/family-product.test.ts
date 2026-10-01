import { expect, it, vi } from "vitest";
const history = vi.hoisted(() => ({ current: true }));
vi.mock("@temporalio/workflow", () => ({ patched: () => history.current }));
import { collectFamilyProduct } from "./family-product.js";
import { ProductPipelineInputSchema, type PipelineActivities } from "./pipeline-model.js";
import { productInput } from "./resources/testing/gate-fixture.js";

const input = ProductPipelineInputSchema.parse(productInput("unit", "wholefoods"));
const captured = { listingId: "B0096M5PBW", variantId: null, archiveKey: "retained/wf.html" };
it.each([
  ["queued", false, "formula-pending"],
  ["already-queued", false, "formula-pending"],
  ["no-amazon-source", false, "no-amazon-source"],
  ["formula-linked", true, "formula-linked"],
])(
  "records %s without reporting a plain collected product",
  async (requestStatus, known, status) => {
    history.current = true;
    const requestAmazonFormula = vi.fn(async () => ({ status: requestStatus }));
    const activities = {
      findKnownFormula: async () => (known ? { operationId: "amazon-label" } : null),
      requestAmazonFormula,
    } as unknown as PipelineActivities;
    expect(await collectFamilyProduct(input, activities, captured)).toMatchObject({
      status,
      metricsStatus: "metrics-complete",
      metricsOperationId: input.operationId,
      listingId: captured.listingId,
      formulaPending: status === "formula-pending",
    });
    expect(requestAmazonFormula).toHaveBeenCalledExactlyOnceWith({
      brandId: input.brandId,
      listingId: captured.listingId,
      formulaOperationId: known ? "amazon-label" : null,
      metrics: {
        operationId: input.operationId,
        runId: input.runId,
        channel: "wholefoods",
        variantId: null,
        archiveKey: captured.archiveKey,
      },
    });
  },
);

it.each([false, true])(
  "preserves pre-marker activity commands and outputs (known: %s)",
  async (known) => {
    history.current = false;
    const requestAmazonFormula = vi.fn(async () => ({ status: "no-amazon-source" }));
    const activities = {
      findKnownFormula: async () => (known ? { operationId: "old-label" } : null),
      requestAmazonFormula,
    } as unknown as PipelineActivities;
    expect(await collectFamilyProduct(input, activities, captured)).toMatchObject({
      status: "collected",
    });
    expect(requestAmazonFormula).toHaveBeenCalledTimes(known ? 0 : 1);
    if (!known) {
      expect(requestAmazonFormula).toHaveBeenCalledWith({
        brandId: input.brandId,
        listingId: captured.listingId,
      });
    }
  },
);
