import {
  ChannelPlanInputSchema,
  ChannelPlanOutcomeSchema,
  OcrInputSchema,
  type FileAcquireInput,
} from "@crawl-automation/v3-contracts";
import { entry, manifest, owner } from "../../label/label-fixture.js";
import { gateFixture, productInput } from "../../resources/testing/gate-fixture.js";

const hash = "a".repeat(64);
const binding = { sessionId: "replay-session", egressId: "replay-egress" };
const ocr = {
  schemaVersion: 1 as const,
  module: "ocr.file" as const,
  implementationVersion: "ocr/1",
  policyVersion: "ocr/1",
  resultSchemaVersion: 2 as const,
  configFingerprint: hash,
};

/** Synthetic contracts assembled at runtime; no captured pages or saved histories. */
function plannedProduct() {
  const page = manifest.sources[0];
  if (!page) {
    throw new Error("Page fixture must contain a source");
  }
  const sourcePlan = ChannelPlanInputSchema.parse({
    operationId: manifest.operationId,
    owner,
    channel: "gnc",
    parserVersion: "gnc-rendered/1",
    expectedUrl: "https://example.com/product",
    source: {
      ...page.plan.page.page,
      kind: "result-json",
      mediaType: "application/json",
      producer: {
        operationId: "capture-1",
        module: "gnc.http-projection",
        implementationVersion: "gnc-rendered/1",
      },
    },
    binding,
    text: page.plan.text,
    ocr,
    visionConfigFingerprint: hash,
  });
  return { sourcePlan, page };
}

function imagePlan() {
  return {
    imageId: "label-image",
    acquire: {
      ...owner,
      operationId: "file-1",
      module: "file.acquire" as const,
      implementationVersion: "file/1",
      policyVersion: "file/1",
      configFingerprint: hash,
      inputFingerprint: hash,
      resourceId: "label-image",
      binding,
      expectedSha256: null,
    },
    ocrOperationId: "ocr-1",
    ocr,
  };
}

function productEvidence() {
  const { sourcePlan, page } = plannedProduct();
  const image = imagePlan();
  const file = {
    ...page.plan.page.page,
    artifactId: image.imageId,
    kind: "source-image",
    mediaType: "image/jpeg",
    producer: {
      operationId: image.acquire.operationId,
      module: "file.acquire",
      implementationVersion: image.acquire.implementationVersion,
    },
  };
  const task = OcrInputSchema.parse({
    ...owner,
    ...ocr,
    operationId: image.ocrOperationId,
    inputFingerprint: hash,
    file,
  });
  return { sourcePlan, image, file, task };
}

function plannedOutcome(evidence: ReturnType<typeof productEvidence>) {
  const { sourcePlan, image } = evidence;
  const outcome = ChannelPlanOutcomeSchema.parse({
    status: "prepared",
    operationId: sourcePlan.operationId,
    inputFingerprint: hash,
    evidenceKey: "replay/plan.json",
    manifest: {
      ...manifest,
      sources: [
        {
          id: "image",
          kind: "file-image",
          required: true,
          plan: image,
          visionOperationId: "vision-1",
          configFingerprint: hash,
        },
      ],
    },
  });
  return outcome;
}

function imageActivities(evidence: ReturnType<typeof productEvidence>) {
  const { task, file, image } = evidence;
  const review = {
    status: "review",
    operationId: task.operationId,
    reviewId: "ocr-review",
    code: "OCR.UNAVAILABLE",
    automaticRetry: false,
  };
  return {
    acquireProductFile: async ({ acquire }: { acquire: FileAcquireInput }) => ({
      status: "durable",
      operationId: acquire.operationId,
      evidenceKey: "replay/file.json",
      file,
    }),
    prepareImageOcr: async () => ({ status: "prepared", task, evidenceKey: "replay/ocr.json" }),
    ocrFile: async () => ({ ...review, evidenceKey: "replay/ocr-review.json" }),
    resolveOcrReceipt: async () => ({ ...review, imageId: image.imageId }),
  };
}

export function pipelineFixture(queue: string) {
  const gate = gateFixture();
  const evidence = productEvidence();
  const outcome = plannedOutcome(evidence);
  return {
    gate,
    input: {
      ...productInput(queue, "gnc"),
      queues: {
        activities: queue,
        plan: queue,
        label: `${queue}-child`,
        browser: queue,
      },
    },
    activities: {
      ...gate.activities,
      ...imageActivities(evidence),
      captureProduct: async () => ({
        status: "captured",
        sourcePlan: evidence.sourcePlan,
        factsComplete: false,
        labelText: null,
        family: { differsBy: "size", members: [{ listingId: "sibling" }] },
      }),
      prepareChannelProduct: async () => outcome,
      findKnownFormula: async () => null,
      reuseSiblingFormula: async () => ({
        status: "extract",
        reason: "FORMULA.LABEL_TEXT_UNAVAILABLE",
      }),
      prepareLabelTask: async () => ({
        ...entry,
        queues: { activities: queue, model: queue, ocr: queue },
      }),
      prepareLabelHandoff: async () => entry,
    },
  };
}
