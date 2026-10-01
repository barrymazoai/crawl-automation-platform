import { ApplicationFailure } from "@temporalio/common";
import { imageEvidence, imageActivities } from "./label-fallback-image.js";
import { pipelineFixture } from "./product-fixture.js";
import {
  entry,
  manifest,
  pageActivities,
  pageTextOutcome,
  owner,
} from "../../label/label-fixture.js";
import {
  LabelWorkflowInputSchema,
  LoadedPlanSchema,
  type LabelWorkflowInput,
  type State,
} from "../../label/label-model.js";

function inspect(request: { states: State[] }) {
  const failures = request.states.flatMap((state) => {
    if (state.status === "not_matched") {
      return [
        {
          sourceId: state.id,
          code: state.reason ?? "CHANNEL.LABEL_NO_SOURCE",
          executionFact: "executed",
        },
      ];
    }
    return state.status === "unresolved" || state.status === "rejected"
      ? [
          {
            sourceId: state.id,
            code: "CHANNEL.LABEL_PREPARATION_UNVERIFIED",
            executionFact: "unknown",
          },
        ]
      : [];
  });
  return {
    input: request,
    complete: request.states.some((state) => state.status === "registered"),
    terminal: failures.some((failure) => failure.executionFact === "unknown"),
    ...(failures.length ? { reason: failures[0], failures } : {}),
  };
}

/** Valid synthetic page and image contracts shared by workflow and real-SDK replay tests. */
export async function labelFallbackFixture(queue = "label-fallback") {
  const product = pipelineFixture(queue);
  const prepared = await product.activities.prepareChannelProduct();
  if (prepared.status !== "prepared") {
    throw new Error("Missing image plan");
  }
  const { task } = await product.activities.prepareImageOcr();
  const image = imageEvidence(task);
  const input = LabelWorkflowInputSchema.parse({
    ...entry,
    queues: { activities: queue, model: queue, ocr: queue },
    input: {
      ...entry.input,
      corePolicy: "swanson-label-core/1",
      admission: "label-packaging/1",
      sourcePolicy: { version: "label-sources/1", order: "text-first" },
      evidencePolicy: "label-image-first/6",
    },
  });
  const loaded = LoadedPlanSchema.parse({
    input: input.input,
    manifest: { ...manifest, sources: [...manifest.sources, ...prepared.manifest.sources] },
    imageOrder: ["image"],
    labelPreparation: { pageHasLabelSection: true, pageFactsComplete: true },
  });
  return {
    input,
    loaded,
    file: task.file,
    activities: {
      ...fixtureActivities(loaded),
      ...imageActivities(task, image),
      prepareSingleLabelManifest: async () => selectedManifest(input, image),
    },
  };
}

function fixtureActivities(loaded: ReturnType<typeof LoadedPlanSchema.parse>) {
  return {
    ...pageActivities(),
    loadLabelPlan: async () => loaded,
    prepareLabelCore: async () => {
      throw ApplicationFailure.nonRetryable("No single label", "LABEL_CORE.LABEL_SCOPE_AMBIGUOUS");
    },
    inspectLabelImage: async (request: { states: State[] }) => inspect(request),
    reviewLabelProduct: async (request: { code: string; primaryFailure?: { code: string } }) => ({
      ...(await pageActivities().reviewLabelProduct(request)),
      code: request.primaryFailure?.code ?? request.code,
    }),
  };
}

function selectedManifest(input: LabelWorkflowInput, image: ReturnType<typeof imageEvidence>) {
  return {
    input: input.input,
    manifest: {
      operationId: input.input.operationId,
      observation: owner,
      sources: [image.source],
      evidencePolicy: input.input.evidencePolicy,
      admission: {
        policy: "label-packaging/1",
        comparison: "label-typography/2",
        documents: [pageTextOutcome.task.source.document],
      },
    },
    skipped: ["page"],
  };
}
