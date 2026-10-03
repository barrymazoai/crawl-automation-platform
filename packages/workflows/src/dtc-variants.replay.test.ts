import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import {
  ChannelPlanInputSchema,
  ResourceRequestSchema,
  type DtcVariantHandoff,
  type EnrichmentRequest,
} from "@crawl-automation/v3-contracts";
import { currentBundle, withoutPatches, type ReplayBundle } from "./testing/replay/bundles.js";
import { recordHistory, childCommands } from "./testing/replay/history.js";
import { pipelineFixture } from "./testing/replay/product-fixture.js";

let environment: TestWorkflowEnvironment;
let bundle: ReplayBundle;
beforeAll(async () => {
  bundle = await currentBundle();
  environment = await TestWorkflowEnvironment.createLocal();
}, 60_000);
afterAll(async () => {
  await environment?.teardown();
});

it.each(["expanded", "partial", "before-patch", "before-id-patch"])(
  "replays DTC variant children: %s",
  async (scenario) => {
    const queue = `dtc-variants-${randomUUID()}`;
    const fixture = pipelineFixture(queue);
    const captured = await fixture.activities.captureProduct();
    const sourcePlan = ChannelPlanInputSchema.parse({
      ...captured.sourcePlan,
      channel: "dtc",
      parserVersion: "dtc-agent/1",
      expectedUrl: "https://shop.example/products/zinc",
      source: {
        ...captured.sourcePlan.source,
        producer: {
          ...captured.sourcePlan.source.producer,
          module: "dtc.browser-projection",
          implementationVersion: "dtc-agent/1",
        },
      },
    });
    const variants: DtcVariantHandoff[] = ["one", "two"].map((variantId) => ({
      status: "ready",
      operationId:
        scenario === "before-id-patch"
          ? `capture-${variantId}`
          : `dtc-variant-${(variantId === "one" ? "1" : "2").repeat(64)}`,
      evidence: ["observed.html"],
      variant: {
        listingId: sourcePlan.owner.listingId,
        variantId,
        title: variantId,
        url: `${sourcePlan.expectedUrl}?variant=${variantId}`,
        available: variantId !== "one",
      },
      planned: {
        status: "captured",
        factsComplete: false,
        labelText: null,
        family: null,
        sourcePlan: {
          ...sourcePlan,
          expectedUrl: `${sourcePlan.expectedUrl}?variant=${variantId}`,
          owner: { ...sourcePlan.owner, variantId },
          source: { ...sourcePlan.source, variantId },
        },
      },
    }));
    if (scenario === "partial") {
      const first = variants[0];
      if (!first) {
        throw new Error("fixture");
      }
      variants[0] = {
        ...first,
        status: "review",
        code: "DTC.VARIANT_EVIDENCE",
        reason: "Unavailable variant state",
      };
      delete (variants[0] as unknown as Record<string, unknown>).planned;
    }
    const captureBrowserProduct = vi.fn(async () => ({
      status: "captured",
      listingId: sourcePlan.owner.listingId,
      variantId: null,
      archiveKey: "retained/original.html",
      planned: { ...captured, sourcePlan, family: null },
      variants,
    }));
    const enrichCollectedProduct = vi.fn(async (request: EnrichmentRequest) =>
      registered(request.variantId ?? "base"),
    );
    const input = {
      ...fixture.input,
      channel: "dtc",
      capture: "browser",
      url: sourcePlan.expectedUrl,
    };
    // Isolated test queue keeps the recorded pre-host-routing protocol; replay uses the untouched bundle.
    const recording = withoutPatches(bundle, [
      "browser-resource-routing-v1",
      ...(scenario === "before-patch" ? ["dtc-variant-handoff-v1" as const] : []),
      ...(scenario === "before-id-patch" ? ["dtc-variant-workflow-id-v1" as const] : []),
    ]);
    const { history, result, workflowId } = await recordHistory({
      environment,
      bundle: recording,
      queue,
      workflow: "ProductPipelineWorkflow",
      workflowId: `product-run-${randomUUID()}`,
      input,
      activities: {
        ...fixture.activities,
        reserveResources: async (raw: unknown) =>
          fixture.gate.activities.reserveResources(ResourceRequestSchema.parse(raw)),
        reviewProduct: async (request: unknown) => ({ status: "review", request }),
        captureBrowserProduct,
        findKnownFormula: async () => ({ operationId: "known-formula" }),
        prepareProductEnrichment: async () => ({
          queue,
          resources: {
            queue,
            activities: { enrichCollectedProduct: [{ resourceId: "model", units: 1 }] },
          },
        }),
        enrichCollectedProduct,
      },
    });
    expect(captureBrowserProduct).toHaveBeenCalledOnce();
    expect(fixture.gate.held.size).toBe(0);
    if (scenario === "before-patch") {
      expect(result).toMatchObject({ status: "collected", enrichment: { status: "registered" } });
      expect(childCommands(history).types).toEqual(["ProductEnrichmentWorkflow"]);
    } else {
      expect(result).toMatchObject({
        status: scenario === "partial" ? "review" : "collected",
        counts: {
          total: 2,
          completed: scenario === "partial" ? 1 : 2,
          review: scenario === "partial" ? 1 : 0,
        },
      });
      expect(childCommands(history).types).toEqual(
        scenario === "partial"
          ? ["DtcVariantWorkflow"]
          : ["DtcVariantWorkflow", "DtcVariantWorkflow"],
      );
      expect(
        enrichCollectedProduct.mock.calls.map(([request]) => request.captureOperationId),
      ).toEqual(
        variants
          .filter((variant) => variant.status === "ready")
          .map((variant) => variant.operationId),
      );
    }
    await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId);
  },
  60_000,
);

function registered(title: string) {
  return {
    status: "registered",
    enrichmentId: "a".repeat(64),
    reused: false,
    variantCode: "b".repeat(64),
    evidenceKey: "retained/enrichment.json",
    candidate: {
      unifiedName: title,
      baseName: "Zinc",
      form: "tablet",
      variant: { count: null, size: null, flavor: null, strength: null },
      healthFunctions: [],
      confidence: 1,
      notes: null,
    },
  };
}
