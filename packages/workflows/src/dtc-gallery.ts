import { z } from "zod";
import {
  proxyActivities,
  isCancellation,
  executeChild,
  uuid4,
  ParentClosePolicy,
  ChildWorkflowCancellationType,
  patched,
} from "@temporalio/workflow";
import {
  DtcGalleryRefSchema,
  ChannelPlanInputSchema,
  DtcVariantHandoffsSchema,
  OcrInputSchema,
  OcrReceiptOutcomeSchema,
  ResourceGateSchema,
  type ChannelPlanInput,
  type DtcVariantHandoff,
} from "@crawl-automation/v3-contracts";
import { ProductPipelineInputSchema, type ProductPipelineInput } from "./pipeline-model.js";
import { once, heartbeatTimeout } from "./activity-options.js";
import { versionedResourceGate } from "./resources/versioned-gate.js";
import { withHeartbeatFailure } from "./label/activity-heartbeat.js";

interface GalleryActivities {
  prepareDtcGallery(raw: unknown): Promise<unknown>;
  finishDtcGallery(raw: unknown): Promise<unknown>;
  ocrFile(raw: unknown): Promise<unknown>;
  resolveOcrReceipt(raw: unknown): Promise<unknown>;
  scopeDtcGalleryImage(raw: unknown): Promise<unknown>;
  selectDtcGalleryFacts(raw: unknown): Promise<unknown>;
}
const Prepared = z.strictObject({
  task: DtcGalleryRefSchema,
  inputs: z.array(OcrInputSchema).min(1).max(100),
  queues: z.strictObject({ activities: z.string(), ocr: z.string(), model: z.string() }),
  resources: ResourceGateSchema,
});

/** Browser and its permit have already ended. Ordinary variants never enter this branch. */
export async function resolveDtcGallery(
  input: ProductPipelineInput,
  sourcePlan: ChannelPlanInput,
  variants: DtcVariantHandoff[],
) {
  if (!variants.some((member) => member.status === "mixed")) {
    return variants;
  }
  return DtcVariantHandoffsSchema.parse(
    await executeChild("DtcGalleryWorkflow", {
      workflowId: `dtc-gallery-${uuid4()}`,
      taskQueue: input.queues.activities,
      args: [{ input, sourcePlan, variants }],
      retry: { maximumAttempts: 1 },
      parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
      cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED,
    }),
  );
}

/** A separate run owns prepass permits; it cannot collide with capture's permit sequence. */
export async function DtcGalleryWorkflow(raw: unknown) {
  const { input, sourcePlan, variants } = z
    .strictObject({
      input: ProductPipelineInputSchema,
      sourcePlan: ChannelPlanInputSchema,
      variants: DtcVariantHandoffsSchema,
    })
    .parse(raw);
  if (input.channel !== "dtc" || sourcePlan.channel !== "dtc") {
    throw new Error("DTC.GALLERY_REQUEST");
  }
  const pipeline = proxyActivities<GalleryActivities>({
    taskQueue: input.queues.activities,
    ...once,
  });
  try {
    const prepared = Prepared.parse(await pipeline.prepareDtcGallery({ sourcePlan, variants }));
    const gate = versionedResourceGate(prepared.resources);
    const decisions = await processImages(prepared, gate);
    const selections = patched("dtc-gallery-joint-facts-v1")
      ? { selections: await selectFacts({ prepared, decisions, gate }) }
      : {};
    return DtcVariantHandoffsSchema.parse(
      await pipeline.finishDtcGallery({ task: prepared.task, decisions, ...selections }),
    );
  } catch (error) {
    if (isCancellation(error)) {
      throw error;
    }
    return galleryFailure(variants, error);
  }
}

async function selectFacts(context: {
  prepared: z.infer<typeof Prepared>;
  decisions: z.infer<typeof DtcGalleryRefSchema>[];
  gate: ReturnType<typeof versionedResourceGate>;
}) {
  const { prepared, decisions, gate } = context;
  const selected = await gate("selectDtcGalleryFacts", (binding) =>
    withHeartbeatFailure(() =>
      proxyActivities<GalleryActivities>({
        taskQueue: prepared.queues.model,
        ...once,
        heartbeatTimeout,
        ...binding,
      }).selectDtcGalleryFacts({ task: prepared.task, decisions }),
    ),
  );
  return DtcGalleryRefSchema.array().max(200).parse(selected);
}

async function processImages(
  prepared: z.infer<typeof Prepared>,
  gate: ReturnType<typeof versionedResourceGate>,
) {
  const decisions = [];
  for (const ocr of prepared.inputs) {
    const outcome = await gate("ocrFile", (binding) =>
      withHeartbeatFailure(() =>
        proxyActivities<GalleryActivities>({
          taskQueue: prepared.queues.ocr,
          ...once,
          heartbeatTimeout,
          ...binding,
        }).ocrFile({ input: ocr, verifiedFailure: true }),
      ),
    );
    await verifyReceipt(prepared, { input: ocr, outcome });
    const decision = await gate("scopeDtcGalleryImage", (binding) =>
      withHeartbeatFailure(() =>
        proxyActivities<GalleryActivities>({
          taskQueue: prepared.queues.model,
          ...once,
          heartbeatTimeout,
          ...binding,
        }).scopeDtcGalleryImage({ task: prepared.task, imageId: ocr.file.artifactId }),
      ),
    );
    decisions.push(DtcGalleryRefSchema.parse(decision));
  }
  return decisions;
}

async function verifyReceipt(
  prepared: z.infer<typeof Prepared>,
  request: { input: z.infer<typeof OcrInputSchema>; outcome: unknown },
) {
  const { input: ocr, outcome } = request;
  const receipt = OcrReceiptOutcomeSchema.parse(
    await proxyActivities<GalleryActivities>({
      taskQueue: prepared.queues.activities,
      ...once,
    }).resolveOcrReceipt({ input: ocr, outcome }),
  );
  if (
    receipt.status !== "registered" ||
    receipt.registration.input.inputFingerprint !== ocr.inputFingerprint
  ) {
    throw new Error("DTC.GALLERY_OCR_UNVERIFIED");
  }
}

function galleryFailure(variants: DtcVariantHandoff[], error: unknown) {
  return variants.map((member) =>
    member.status !== "mixed"
      ? member
      : {
          operationId: member.operationId,
          variant: member.variant,
          evidence: member.evidence,
          status: "review" as const,
          code: "DTC.VARIANT_EVIDENCE" as const,
          reason: `DTC gallery preprocessing failed: ${String(error).slice(0, 3500)}`,
        },
  );
}
