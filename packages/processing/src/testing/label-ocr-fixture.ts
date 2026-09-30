import { vi } from "vitest";
import { RetainedPublication, sha256 } from "@crawl-automation/platform";
import {
  AcquiredFileRecordSchema,
  type AcquiredFileRecord,
  type OcrInput,
  type SavedEvidenceSource,
} from "@crawl-automation/v3-contracts";
import { ImageOcrTask } from "../images/image-ocr-task.js";
import { KeywordScreening } from "../keywords/keyword-screening.js";
import { LedgerOcrText } from "../keywords/ocr-text.js";
import { LabelPlans } from "../label/label-plans.js";
import { SavedSourceEvidence } from "../label/saved-sources.js";
import { OcrReceipt } from "../ocr/ocr-receipt.js";
import { OcrStep } from "../ocr/ocr-step.js";
import { hashString } from "../results/result-record.js";
import { defined } from "./defined.js";
import { labelPlanSetup } from "./label-fixture.js";
import { visionFingerprint } from "./label-sources.js";
import { PNG, ocrStepSetup, remoteArtifacts, signal } from "./ocr-fixture.js";

type Image = Extract<SavedEvidenceSource, { kind: "file-image" }>;
type Plan = Awaited<ReturnType<typeof labelPlanSetup>>;

/** Download records stand in for acquisition; OCR, receipts, keywords and source preparation are real. */
function downloadedRecords(plan: Plan) {
  const records = new Map<string, AcquiredFileRecord>();
  for (const image of plan.images) {
    const resolved = image.resolution;
    if (image.source.kind !== "file-image" || resolved.status !== "resolved") {
      throw new Error("Expected a planned image");
    }
    if (resolved.source.kind !== "image") {
      throw new Error("Expected image evidence");
    }
    const file = { ...resolved.source.task.input.selection.image, sha256: sha256(PNG) };
    const record = AcquiredFileRecordSchema.parse({
      schemaVersion: 1,
      codec: "acquired-file/1",
      input: image.source.plan.acquire,
      file,
      dimensions: null,
      redirects: 0,
    });
    records.set(record.input.operationId, record);
  }
  return records;
}

/** One product with only images; no page facts can mask the all-empty case. */
export async function labelOcrSetup(answers: (string | Error)[]) {
  const plan = await labelPlanSetup({ imageTexts: answers.map(() => "Supplement Facts") });
  const images = plan.manifest.sources.filter(
    (source): source is Image => source.kind === "file-image",
  );
  plan.manifest.sources = images;
  const ocr = ocrStepSetup();
  const records = downloadedRecords(plan);
  const replies = new Map(images.map((source, index) => [source.plan.imageId, answers[index]]));
  const recognize = vi.fn(async (file: OcrInput["file"]) => {
    const answer = defined(replies.get(file.artifactId));
    if (answer instanceof Error) {
      throw answer;
    }
    return { text: answer, lines: [] };
  });
  const step = new OcrStep({ ...ocr.deps, api: { ...ocr.api, recognize } });
  for (const record of records.values()) {
    ocr.remote.data.set(record.file.objectKey, PNG);
  }
  const steps = sourceSteps(ocr, records);
  const publication = new RetainedPublication(ocr.local, ocr.remote);
  const resolve = (source: SavedEvidenceSource, signal: AbortSignal) =>
    steps.saved.resolve(source, { id: source.id, status: "unresolved" }, signal);
  const plans = new LabelPlans({ plans: plan.plans, publication, resolve });
  return {
    plan,
    images,
    ocr: { ...ocr, step },
    recognize,
    records,
    ...steps,
    plans,
    publication,
    input: plan.input,
  };
}

function sourceSteps(
  ocr: ReturnType<typeof ocrStepSetup>,
  records: Map<string, AcquiredFileRecord>,
) {
  const { local, remote, reviews, results, registry } = ocr;
  const downloads = {
    inspect: async (input: { operationId: string }) => records.get(input.operationId) ?? null,
    evidenceKey: (input: { operationId: string }) => `v3/acquisition/${input.operationId}.json`,
    imageId: (operationId: string) => `file-${hashString(operationId)}`,
  };
  const screen = new LedgerOcrText({ artifacts: remoteArtifacts(remote), results, registry });
  const saved = new SavedSourceEvidence({
    remote,
    files: downloads,
    pages: { inspect: async () => null },
    ocr: registry,
    screen,
    reviews,
    visionFingerprint,
  });
  return {
    screen,
    saved,
    imageTask: new ImageOcrTask({ downloads, local, remote, reviews }),
    receipt: new OcrReceipt({ results, local, reviews }),
    keywords: new KeywordScreening({ text: screen, local, remote, reviews }),
  };
}

/** The same sequence as LabelWorkflow, up to its source preparation. */
export async function runLabelOcr(setup: Awaited<ReturnType<typeof labelOcrSetup>>) {
  const receipts = [];
  for (const source of setup.images) {
    const prepared = await setup.imageTask.run({ plan: source.plan, receipt: null }, signal());
    if (prepared.status !== "prepared") {
      throw new Error(JSON.stringify(prepared));
    }
    const outcome = await setup.ocr.step.run(prepared.task, signal());
    const receipt = await setup.receipt.run({ input: prepared.task, outcome }, signal());
    receipts.push(receipt);
    if (receipt.status === "registered") {
      await setup.keywords.run(receipt.registration, signal());
    }
  }
  return receipts;
}
