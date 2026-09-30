import { isDeepStrictEqual } from "node:util";
import type { ObjectStore } from "@crawl-automation/platform";
import {
  KeywordResultSchema,
  OcrInputSchema,
  fingerprintOcrInput,
  observationIdentity,
  type AcquiredFileRecord,
  type FileAcquireInput,
  type OcrRegistration,
  type PagePrepareInput,
  type PreparedPageRecord,
  type ReviewRecord,
  type SavedEvidenceSource,
  type VisionTask,
} from "@crawl-automation/v3-contracts";
import { keywordKey } from "../keywords/keyword-screening.js";
import type { LedgerOcrText } from "../keywords/ocr-text.js";
import { pageTextInputKey, pageTextTask } from "../pages/page-text.js";
import { decodeJson, hashString } from "../results/result-record.js";
import { labelFailure } from "./label-errors.js";

export interface SavedSourceDeps {
  remote: ObjectStore;
  files?: {
    inspect(input: FileAcquireInput, signal: AbortSignal): Promise<AcquiredFileRecord | null>;
  };
  pages: {
    inspect(input: PagePrepareInput, signal: AbortSignal): Promise<PreparedPageRecord | null>;
  };
  ocr: { read(operationId: string): Promise<OcrRegistration | null> };
  screen: Pick<LedgerOcrText, "screen" | "verifiedText">;
  reviews: { read(reviewId: string): Promise<ReviewRecord | null> };
  visionFingerprint: (task: VisionTask) => string;
}

type Of<Kind extends SavedEvidenceSource["kind"]> = Extract<SavedEvidenceSource, { kind: Kind }>;

const TASK_LIMIT = 65_536;
const DECISION_LIMIT = 1024 * 1024;

/** The tasks a saved source's prepared evidence stands for, each re-derived from that evidence. */
export class SavedSourceTasks {
  constructor(readonly deps: SavedSourceDeps) {}

  async page(source: Of<"page">, signal: AbortSignal) {
    const record = await this.deps.pages.inspect(source.plan.page, signal);
    if (!record) {
      throw labelFailure("SAVED.PAGE_UNCONFIRMED");
    }
    const task = pageTextTask(source.plan, record);
    const expected = { plan: source.plan, record, task };
    if (
      !(await this.stored(pageTextInputKey(source.plan), { expected, limit: TASK_LIMIT }, signal))
    ) {
      throw labelFailure("SAVED.PAGE_INPUT_UNCONFIRMED");
    }
    return { id: source.id, required: source.required, kind: "text" as const, task };
  }

  async registration(source: Of<"ocr-image">): Promise<OcrRegistration> {
    const record = await this.deps.ocr.read(source.task.operationId);
    if (!record || !isDeepStrictEqual(record.input, source.task)) {
      throw labelFailure("SAVED.OCR_UNCONFIRMED");
    }
    return record;
  }

  async image(source: Of<"ocr-image">, signal: AbortSignal) {
    const selection = await this.deps.screen.screen(await this.registration(source), signal);
    const bytes = await this.deps.remote.read(keywordKey(selection), DECISION_LIMIT, signal);
    if (!bytes || !isDeepStrictEqual(KeywordResultSchema.parse(decodeJson(bytes)), selection)) {
      throw labelFailure("SAVED.KEYWORDS_UNCONFIRMED");
    }
    const input = { operationId: source.visionOperationId, selection };
    const task = { input, configFingerprint: source.configFingerprint };
    return { id: source.id, required: source.required, kind: "image" as const, task };
  }

  /** The OCR task a downloaded image stands for, confirmed against the image preparation's own evidence. */
  async fileOcrSource(source: Of<"file-image">, signal: AbortSignal): Promise<Of<"ocr-image">> {
    const { plan } = source;
    const { record, file } = await this.downloadedImage(source, signal);
    const unsigned = {
      ...observationIdentity(plan.acquire),
      ...plan.ocr,
      operationId: plan.ocrOperationId,
      file,
    };
    const task = OcrInputSchema.parse({
      ...unsigned,
      inputFingerprint: fingerprintOcrInput(unsigned, hashString),
    });
    const key = `v3/acquisition/${plan.acquire.operationId}/ocr-${plan.ocrOperationId}.json`;
    const expected = {
      schemaVersion: 1,
      codec: "image-ocr-input/1",
      plan,
      acquisition: record,
      task,
    };
    if (!(await this.stored(key, { expected, limit: TASK_LIMIT }, signal))) {
      throw labelFailure("SAVED.FILE_INPUT_UNCONFIRMED");
    }
    const { id, required, visionOperationId, configFingerprint } = source;
    return { id, required, kind: "ocr-image", task, visionOperationId, configFingerprint };
  }

  /** The download record of exactly this plan's image, which must be a source image. */
  private async downloadedImage(source: Of<"file-image">, signal: AbortSignal) {
    const { plan } = source;
    const record = await this.deps.files?.inspect(plan.acquire, signal);
    const file = record?.file;
    if (!record || file?.kind !== "source-image") {
      throw labelFailure("SAVED.FILE_UNCONFIRMED");
    }
    if (!isDeepStrictEqual(record.input, plan.acquire) || file.artifactId !== plan.imageId) {
      throw labelFailure("SAVED.FILE_UNCONFIRMED");
    }
    return { record, file };
  }

  private async stored(
    key: string,
    check: { expected: unknown; limit: number },
    signal: AbortSignal,
  ) {
    const bytes = await this.deps.remote.read(key, check.limit, signal);
    return !!bytes && isDeepStrictEqual(decodeJson(bytes), check.expected);
  }
}
