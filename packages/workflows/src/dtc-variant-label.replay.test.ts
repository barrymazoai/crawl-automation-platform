import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { expect, it, vi } from "vitest";
import {
  ChannelPlanInputSchema,
  ResourceRequestSchema,
  ExecutionIdSchema,
  type DtcVariantHandoff,
} from "@crawl-automation/v3-contracts";
import { currentBundle, withoutPatches } from "./testing/replay/bundles.js";
import { recordHistory, scheduledActivities } from "./testing/replay/history.js";
import { pipelineFixture } from "./testing/replay/product-fixture.js";
import { ocrWalkFixture } from "./label/ocr-walk-fixture.js";

it("admits OCR in real DTC variant descendants with production-length identities", async () => {
  const bundle = await currentBundle();
  const environment = await TestWorkflowEnvironment.createLocal();
  try {
    const queue = `dtc-label-${randomUUID()}`;
    const product = pipelineFixture(queue);
    const label = await ocrWalkFixture(queue, "timeout");
    const capture = await product.activities.captureProduct();
    const sourcePlan = ChannelPlanInputSchema.parse({
      ...capture.sourcePlan,
      channel: "dtc",
      parserVersion: "dtc-agent/1",
      source: {
        ...capture.sourcePlan.source,
        producer: {
          ...capture.sourcePlan.source.producer,
          module: "dtc.browser-projection",
          implementationVersion: "dtc-agent/1",
        },
      },
    });
    const variants: DtcVariantHandoff[] = ["1", "2"].map((id) => ({
      status: "ready",
      operationId: `dtc-variant-${id.repeat(64)}`,
      evidence: ["retained.html"],
      variant: {
        listingId: sourcePlan.owner.listingId,
        variantId: id,
        url: `${sourcePlan.expectedUrl}?variant=${id}`,
        title: id,
        available: true,
      },
      planned: {
        ...capture,
        status: "captured",
        family: null,
        sourcePlan: {
          ...sourcePlan,
          owner: { ...sourcePlan.owner, variantId: id },
          source: { ...sourcePlan.source, variantId: id },
          expectedUrl: `${sourcePlan.expectedUrl}?variant=${id}`,
        },
      },
    }));
    const ocr = vi.fn(label.activities.ocrFile);
    const reserve = vi.fn(async (raw: unknown) =>
      product.gate.activities.reserveResources(ResourceRequestSchema.parse(raw)),
    );
    const input = {
      ...product.input,
      channel: "dtc",
      capture: "browser",
      queues: { activities: queue, plan: queue, label: queue, browser: queue },
    };
    const recording = withoutPatches(bundle, ["browser-resource-routing-v1"]);
    const result = await recordHistory({
      environment,
      bundle: recording,
      queue,
      workflow: "ProductPipelineWorkflow",
      workflowId: `product-run-${randomUUID()}`,
      input,
      activities: {
        ...product.activities,
        ...label.activities,
        reserveResources: reserve,
        ocrFile: ocr,
        captureBrowserProduct: async () => ({
          status: "captured",
          listingId: sourcePlan.owner.listingId,
          variantId: null,
          archiveKey: "retained.html",
          planned: { ...capture, sourcePlan },
          variants,
        }),
        prepareChannelProduct: async () => ({
          status: "prepared",
          operationId: sourcePlan.operationId,
          inputFingerprint: "a".repeat(64),
          evidenceKey: "plan.json",
          manifest: label.loaded.manifest,
        }),
        prepareLabelTask: async () => ({
          ...label.input,
          resources: {
            queue,
            releaseOnReview: true,
            activities: { ocrFile: [{ resourceId: "ocr", units: 1 }] },
          },
        }),
        acquireProductFile: async ({ acquire }: { acquire: { operationId: string } }) => ({
          status: "durable",
          operationId: acquire.operationId,
          evidenceKey: "file.json",
          file: label.tasks.find((task) => task.file.producer.operationId === acquire.operationId)
            ?.file,
        }),
      },
    });
    // The synthetic OCR service deliberately returns a verified failure. Both variant walks must
    // nevertheless acquire valid resources and execute both images exactly once, then release.
    expect(result.result).toMatchObject({
      status: "review",
      counts: { total: 2, completed: 0, review: 2 },
    });
    expect(ocr).toHaveBeenCalledTimes(4);
    expect(product.gate.held.size).toBe(0);
    const childIds =
      result.history.events?.flatMap((event) => {
        const child = event.startChildWorkflowExecutionInitiatedEventAttributes;
        return child?.workflowId ? [child.workflowId] : [];
      }) ?? [];
    expect(new Set(childIds).size).toBe(2);
    for (const childId of childIds) {
      expect(ExecutionIdSchema.safeParse(`${childId}-enrichment`).success).toBe(true);
      const labelId = `${childId}-label`;
      expect(ExecutionIdSchema.safeParse(labelId).success).toBe(true);
      const history = await environment.client.workflow.getHandle(labelId).fetchHistory();
      expect(scheduledActivities(history).filter((name) => name === "ocrFile")).toHaveLength(2);
      await Worker.runReplayHistory({ workflowBundle: bundle }, history, labelId);
      const variantHistory = await environment.client.workflow.getHandle(childId).fetchHistory();
      await Worker.runReplayHistory({ workflowBundle: bundle }, variantHistory, childId);
    }
    await Worker.runReplayHistory({ workflowBundle: bundle }, result.history, result.workflowId);
  } finally {
    await environment.teardown();
  }
}, 60_000);
