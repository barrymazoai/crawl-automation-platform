import { recordRecovery } from "@crawl-automation/platform";
import { errorCodeOf, type ObjectStore } from "@crawl-automation/platform";
import {
  decodeJson,
  ocrKeys,
  parseOcrTask,
  parseTextTask,
  textKeys,
} from "@crawl-automation/processing";
import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import { z } from "zod";

/** One evidence file of a Review, as stored in R2. */
export interface EvidenceFile {
  key: string;
  status: "present" | "missing" | "too_large" | "unreadable";
  byteSize: number | null;
  /** Parsed JSON, or the text itself; null when it is absent, too large or not UTF-8. */
  content: unknown;
  /** Why it could not be read, when it could not. */
  code: string | null;
}

/** Files larger than this are listed but not returned. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const IntentSchema = z.object({ input: z.unknown() });

/** The result files a step writes beside its intent, found from the task the intent names. */
const RESULT_PREFIXES: Record<string, (input: unknown) => string> = {
  "codex.text": (input) => textKeys.prefix(parseTextTask(input)),
  "ocr.file": (input) => ocrKeys.prefix(parseOcrTask(input)),
};

/** A Review's evidence files from R2: its evidence key and, for text and OCR, the task's result files. Read only. */
export class ReviewEvidence {
  constructor(private readonly deps: { objects: Pick<ObjectStore, "read"> }) {}

  async files(review: ReviewRecord, signal: AbortSignal): Promise<EvidenceFile[]> {
    const main = await this.file(review.failure.evidenceKey, signal);
    const results = await this.resultKeys(review, main);
    return [main, ...(await Promise.all(results.map((key) => this.file(key, signal))))];
  }

  private async resultKeys(review: ReviewRecord, intent: EvidenceFile): Promise<string[]> {
    const prefixOf = RESULT_PREFIXES[review.failure.stage];
    const parsed = IntentSchema.safeParse(intent.content);
    if (!prefixOf || !parsed.success) {
      return [];
    }
    let prefix: string;
    try {
      prefix = prefixOf(parsed.data.input);
    } catch (error) {
      recordRecovery(error, { operation: "reviews/review-evidence" });
      // An intent that names no valid task has no result files to find; the intent itself is returned as is.
      return [];
    }
    return [`${prefix}/result.json`, `${prefix}/completion.json`];
  }

  private async file(key: string, signal: AbortSignal): Promise<EvidenceFile> {
    let bytes: Uint8Array | null;
    try {
      bytes = await this.deps.objects.read(key, MAX_FILE_BYTES, signal);
    } catch (error) {
      const code = errorCodeOf(error);
      const status = code?.endsWith(".TOO_LARGE") ? "too_large" : "unreadable";
      return { key, status, byteSize: null, content: null, code };
    }
    if (!bytes) {
      return { key, status: "missing", byteSize: null, content: null, code: null };
    }
    return { key, status: "present", byteSize: bytes.length, content: readable(bytes), code: null };
  }
}

/** JSON when it parses, otherwise the UTF-8 text; null for bytes that are not text. */
function readable(bytes: Uint8Array): unknown {
  try {
    return decodeJson(bytes);
  } catch (error) {
    recordRecovery(error, { operation: "reviews/review-evidence" });
    // Not JSON: fall back to the text below.
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    recordRecovery(error, { operation: "reviews/review-evidence" });
    // Binary evidence (an image, a PDF) is listed with its size only.
    return null;
  }
}
