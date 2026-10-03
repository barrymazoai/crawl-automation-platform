import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import {
  ChannelPlanInputSchema,
  ResourceRequestSchema,
  type OcrInput,
  type DtcVariantHandoff,
} from "@crawl-automation/v3-contracts";
import { currentBundle, type ReplayBundle } from "./testing/replay/bundles.js";
import { recordHistory } from "./testing/replay/history.js";
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

it.each(["scoped", "ocr-review", "scope-failure"])(
  "replays the DTC-only prepass: %s",
  async (scenario) => {
    const queue = `dtc-gallery-${randomUUID()}`;
    const fixture = pipelineFixture(queue);
    const captured = await fixture.activities.captureProduct();
    const sourcePlan = ChannelPlanInputSchema.parse({
      ...captured.sourcePlan,
      channel: "dtc",
      parserVersion: "dtc-agent/1",
      source: {
        ...captured.sourcePlan.source,
        producer: {
          ...captured.sourcePlan.source.producer,
          module: "dtc.browser-projection",
          implementationVersion: "dtc-agent/1",
        },
      },
    });
    const variants: DtcVariantHandoff[] = ["mixed", "ready"].map((status, index) => ({
      status: status as "mixed" | "ready",
      operationId: `variant-${index}`,
      evidence: ["state.html"],
      variant: {
        listingId: sourcePlan.owner.listingId,
        variantId: String(index),
        title: String(index),
        url: sourcePlan.expectedUrl,
      },
      planned: {
        status: "captured",
        sourcePlan,
        factsComplete: false,
        labelText: null,
        family: null,
      },
    }));
    const { task: ocr } = await fixture.activities.prepareImageOcr();
    const ref = { objectKey: "retained/task.json", sha256: "a".repeat(64), byteSize: 100 };
    const ocrFile = vi.fn(fixture.activities.ocrFile);
    const scopeDtcGalleryImage = vi.fn(async () => {
      if (scenario === "scope-failure") {
        throw new Error("Model unavailable");
      }
      return ref;
    });
    const finishDtcGallery = vi.fn(async () =>
      variants.map((member) => ({ ...member, status: "ready" })),
    );
    const { history, result, workflowId } = await recordHistory({
      environment,
      bundle,
      queue,
      workflow: "DtcGalleryWorkflow",
      input: { input: { ...fixture.input, channel: "dtc" }, sourcePlan, variants },
      activities: {
        ...fixture.activities,
        reserveResources: async (raw: unknown) =>
          fixture.gate.activities.reserveResources(ResourceRequestSchema.parse(raw)),
        prepareDtcGallery: async () => ({
          task: ref,
          inputs: [ocr],
          queues: { activities: queue, ocr: queue, model: queue },
          resources: {
            ...fixture.input.resources,
            activities: {
              ocrFile: [{ resourceId: "ocr", units: 1 }],
              scopeDtcGalleryImage: [{ resourceId: "model", units: 1 }],
            },
          },
        }),
        ocrFile,
        resolveOcrReceipt: async () =>
          scenario === "ocr-review" ? fixture.activities.resolveOcrReceipt() : registeredOcr(ocr),
        scopeDtcGalleryImage,
        finishDtcGallery,
      },
    });
    expect(ocrFile).toHaveBeenCalledOnce();
    expect(scopeDtcGalleryImage).toHaveBeenCalledTimes(scenario === "ocr-review" ? 0 : 1);
    expect(finishDtcGallery).toHaveBeenCalledTimes(scenario === "scoped" ? 1 : 0);
    expect((result as DtcVariantHandoff[]).map((member) => member.status)).toEqual([
      scenario === "scoped" ? "ready" : "review",
      "ready",
    ]);
    expect(fixture.gate.held.size).toBe(0);
    await Worker.runReplayHistory({ workflowBundle: bundle }, history, workflowId);
  },
  60_000,
);

function registeredOcr(input: OcrInput) {
  const ref = (kind: string) => ({
    ...input.file,
    artifactId: kind,
    objectKey: `ocr/${kind}.json`,
    kind: "result-json",
    mediaType: "application/json",
    producer: {
      operationId: input.operationId,
      module: input.module,
      implementationVersion: input.implementationVersion,
    },
  });
  return {
    status: "registered",
    registration: {
      schemaVersion: 1,
      storageId: "test/1",
      input,
      result: ref("result"),
      completion: ref("completion"),
    },
  };
}
