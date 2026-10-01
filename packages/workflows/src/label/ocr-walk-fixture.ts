import { OcrInputSchema, type OcrInput } from "@crawl-automation/v3-contracts";
import { pipelineFixture } from "../testing/replay/product-fixture.js";
import { entry, pageActivities } from "./label-fixture.js";
import { LabelWorkflowInputSchema, type ImageSource, type State } from "./label-model.js";

export const ocrFailureMarker = "ocr-verified-failure-v1";
type Failure = { sourceId: string; code: string; executionFact: "executed" | "unknown" };
export type OcrWalkMode = "timeout" | "transport" | "unknown" | "unreachable";

/** Two distinct images; activity answers model the classification tested with the real OCR adapter. */
export async function ocrWalkFixture(queue = "ocr-walk", mode: OcrWalkMode = "timeout") {
  const product = pipelineFixture(queue);
  const prepared = await product.activities.prepareChannelProduct();
  if (prepared.status !== "prepared" || prepared.manifest.sources[0]?.kind !== "file-image") {
    throw new Error("Missing synthetic image plan");
  }
  const first = prepared.manifest.sources[0];
  const sources = [first, nextSource(first)];
  const { task } = await product.activities.prepareImageOcr();
  const tasks = sources.map((source) => imageTask(source, task));
  const input = LabelWorkflowInputSchema.parse({
    ...entry,
    input: {
      ...entry.input,
      evidencePolicy: "label-image-first/6",
      sourcePolicy: { version: "label-sources/1", order: "images-first" },
    },
    queues: { activities: queue, ocr: queue, model: queue },
  });
  const loaded = {
    input: input.input,
    manifest: { ...prepared.manifest, sources },
    imageOrder: sources.map((source) => source.id),
    labelPreparation: { pageHasLabelSection: false, pageFactsComplete: false },
  };
  const files = Object.fromEntries(sources.map((source, index) => [source.id, tasks[index]?.file]));
  return { input, loaded, tasks, files, activities: walkActivities({ loaded, tasks, mode }) };
}

function nextSource(first: ImageSource): ImageSource {
  return {
    ...first,
    id: "image-next",
    plan: {
      ...first.plan,
      imageId: "next-file",
      ocrOperationId: "ocr-next",
      acquire: { ...first.plan.acquire, operationId: "file-next", resourceId: "next-file" },
    },
    visionOperationId: "vision-next",
  };
}

function imageTask(source: ImageSource, first: OcrInput): OcrInput {
  return OcrInputSchema.parse({
    ...first,
    operationId: source.plan.ocrOperationId,
    file: {
      ...first.file,
      artifactId: source.plan.imageId,
      objectKey: `images/${source.plan.imageId}.png`,
      producer: { ...first.file.producer, operationId: source.plan.acquire.operationId },
    },
  });
}

function walkActivities(at: {
  loaded: { manifest: { sources: ImageSource[] } };
  tasks: OcrInput[];
  mode: OcrWalkMode;
}) {
  const failures = new Map<string, Failure>();
  const prepare = async ({ plan }: { plan: ImageSource["plan"] }) => ({
    status: "prepared",
    task: at.tasks.find((task) => task.operationId === plan.ocrOperationId),
    evidenceKey: "ocr/prepare.json",
  });
  const ocrFile = async (raw: unknown) => recordOcr(at, raw, failures);
  return {
    ...pageActivities(),
    loadLabelPlan: async () => at.loaded,
    prepareImageOcr: prepare,
    ocrFile,
    resolveOcrReceipt: async (request: { input: OcrInput; outcome: Record<string, unknown> }) => {
      const { evidenceKey: _key, ...outcome } = request.outcome;
      return { ...outcome, imageId: request.input.file.artifactId };
    },
    inspectLabelImage: async (request: { states: State[] }) => inspect(request, failures),
    reviewLabelProduct: async (request: { code: string; primaryFailure?: { code: string } }) => ({
      ...(await pageActivities().reviewLabelProduct(request)),
      code: request.primaryFailure?.code ?? request.code,
    }),
  };
}

function recordOcr(
  at: { mode: OcrWalkMode; loaded: { manifest: { sources: ImageSource[] } } },
  raw: unknown,
  failures: Map<string, Failure>,
) {
  const request = raw as { input?: OcrInput; verifiedFailure?: boolean };
  const task = OcrInputSchema.parse(request.input ?? raw);
  const known = request.verifiedFailure && ["timeout", "transport"].includes(at.mode);
  const code =
    at.mode === "transport" ? (known ? "OCR.JOB_FAILED" : "OCR.RESPONSE_UNKNOWN") : "OCR.TIMEOUT";
  const source = at.loaded.manifest.sources.find(
    (source) => source.plan.ocrOperationId === task.operationId,
  );
  if (!source) {
    throw new Error("Unplanned OCR task");
  }
  failures.set(source.id, {
    sourceId: source.id,
    code,
    executionFact: known ? "executed" : "unknown",
  });
  return {
    status: "review",
    operationId: task.operationId,
    reviewId: `review-${task.operationId}`,
    code,
    evidenceKey: `ocr/${task.operationId}/review.json`,
    automaticRetry: false,
  };
}

function inspect(request: { states: State[] }, failures: Map<string, Failure>) {
  const reasons = request.states.map((state) => {
    const failure = failures.get(state.id);
    if (state.status !== "review" || !failure) {
      throw new Error("Expected verified OCR Review state");
    }
    return failure;
  });
  return {
    input: request,
    complete: false,
    terminal: reasons.some((failure) => failure.executionFact === "unknown"),
    reason: reasons[0],
    failures: reasons,
  };
}
