import { vi } from "vitest";
import {
  ReviewRecordSchema,
  VisionRecordSchema,
  type LabelImageCandidate,
  type LabelProductManifest,
} from "@crawl-automation/v3-contracts";
import { labelPlanSetup } from "../testing/label-fixture.js";
import { labelCandidate, visionFingerprint } from "../testing/label-sources.js";
import { LabelImageSelection } from "./label-selection.js";
import { LabelPlanInputSchema } from "./label-plan-model.js";

/** The production prefix: three non-labels, one stopped OCR failure, then a registered label. */
export const admissionStates = [
  { id: "image-0", status: "not_matched" as const },
  { id: "image-1", status: "not_matched" as const },
  { id: "image-2", status: "not_matched" as const },
  { id: "image-3", status: "review" as const, reviewId: "ocr-failed" },
  { id: "image-4", status: "registered" as const },
];

interface Options {
  page?: boolean;
  candidate?: LabelImageCandidate;
  code?: string;
  executionFact?: "executed" | "unknown";
}

/** Real plans, selection, schema validation and publication; only retained-evidence I/O is faked. */
export async function orderedAdmissionFixture(options: Options = {}) {
  const setup = await labelPlanSetup({
    imageTexts: Array.from({ length: 7 }, (_, index) =>
      index < 3 ? "Marketing only" : "Supplement Facts",
    ),
    factsIndex: 0,
  });
  if (!options.page) {
    setup.manifest.sources = setup.manifest.sources.filter((source) => source.kind !== "page");
  }
  const planned = {
    ...(await setup.plans.inspect()),
    labelPreparation: { pageHasLabelSection: false, pageFactsComplete: false },
  };
  setup.plans.inspect.mockResolvedValue(planned);
  const input = LabelPlanInputSchema.parse({
    ...setup.input,
    admission: "label-packaging/1",
    evidencePolicy: "label-image-first/6",
    sourcePolicy: { version: "label-sources/1", order: "images-first" },
  });
  const review = ocrReview(input, options);
  setup.resolutions.set("image-3", { status: "review", code: review.failure.code });
  const { inspector, selection } = admissionSelection(setup, { review, options });
  const remaining = ["image-5", "image-6", ...(options.page ? ["page"] : [])];
  const request = {
    input,
    selectedImageId: null,
    states: [
      ...admissionStates,
      ...remaining.map((id) => ({ id, status: "not_started" as const })),
    ],
  };
  return { ...setup, input, request, inspector, selection };
}

function admissionSelection(
  setup: Awaited<ReturnType<typeof labelPlanSetup>>,
  at: { review: ReturnType<typeof ocrReview>; options: Options },
) {
  const inspector = {
    file: vi.fn(async () => true),
    image: vi.fn(),
    review: vi.fn(async () => at.review),
    reviewSource: setup.resolve,
    readSource: vi.fn(async (source: LabelProductManifest["sources"][number]) =>
      registeredImage(source, at.options.candidate ?? labelCandidate()),
    ),
  };
  const selection = new LabelImageSelection(setup.labelPlans, {
    inspection: inspector,
    visionFingerprint,
  });
  return { inspector, selection };
}

function ocrReview(input: ReturnType<typeof LabelPlanInputSchema.parse>, options: Options) {
  return ReviewRecordSchema.parse({
    schemaVersion: 1,
    reviewId: "ocr-failed",
    occurredAt: "2026-10-01T10:26:00Z",
    observation: input.owner,
    failure: {
      schemaVersion: 1,
      requestId: input.owner.requestId,
      observationId: input.owner.observationId,
      operationId: "ocr-op-3",
      inputFingerprint: "a".repeat(64),
      stage: "ocr.file",
      category: "PROCESSING",
      code: options.code ?? "OCR.JOB_FAILED",
      executionFact: options.executionFact ?? "executed",
      evidenceKey: "ocr/ocr-op-3/review.json",
      blockedBy: null,
      automaticRetry: false,
    },
    rawError: { name: "OcrFailure", message: "Stopped OCR job", stack: null, details: {} },
    candidate: null,
    inspection: { kind: "none" },
  });
}

function registeredImage(
  source: LabelProductManifest["sources"][number],
  candidate: LabelImageCandidate,
) {
  if (source.kind !== "image") {
    throw new Error("Expected an image task");
  }
  const { input, configFingerprint } = source.task;
  const artifact = (name: string) => ({
    ...input.selection.image,
    artifactId: `${input.operationId}-${name}`,
    objectKey: `vision/${input.operationId}/${name}.json`,
    kind: "result-json",
    mediaType: "application/json",
    producer: {
      operationId: input.operationId,
      module: "codex.vision",
      implementationVersion: "vision/2",
    },
  });
  const record = VisionRecordSchema.parse({
    schemaVersion: 2,
    codec: "vision-result/2",
    storageId: "test/1",
    input,
    configFingerprint,
    status: "candidate",
    result: artifact("response"),
    completion: artifact("completion"),
  });
  return { id: source.id, kind: "image" as const, record, candidate };
}
