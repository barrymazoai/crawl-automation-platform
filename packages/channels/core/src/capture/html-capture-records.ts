import { defineErrors } from "@crawl-automation/platform";
import type { HtmlCaptureRequest, SavedHtmlOriginal } from "./html-capture-model.js";

export const htmlCaptureErrors = defineErrors({
  "CAPTURE.IN_FLIGHT": {
    category: "SOURCE",
    message: "A capture of this listing may still be running; no second request was made.",
  },
  "CAPTURE.RECORD_CONFLICT": {
    category: "ARTIFACT",
    message: "The capture record conflicts with its immutable identity or outcome.",
  },
});

export type HtmlCaptureAdmission =
  | { status: "download"; previous?: HtmlCaptureRequest[] }
  | { status: "reuse"; original: SavedHtmlOriginal }
  | { status: "in_flight"; operationId: string }
  | { status: "unresolved" };

/**
 * Shared recent-original index and in-flight markers, separate from processing permits.
 * Admission atomically checks the operation, then a saved original younger than 24 hours,
 * then unfinished requests younger than 10 minutes, before recording intent to download.
 * A reuse binds the operation to the original reference without renewing its capture time.
 * A download reservation includes expired unfinished operations: inspect their archives before
 * paying, in case publication succeeded but recording completion did not.
 */
export interface HtmlCaptureRecords {
  admit(request: HtmlCaptureRequest): Promise<HtmlCaptureAdmission>;
  /** Called only after the original receipt and bytes have been read back and verified. */
  complete(request: HtmlCaptureRequest, original: SavedHtmlOriginal): Promise<void>;
  /** Ends a pending download; preserves done if completion committed but its acknowledgement was lost. */
  fail(request: HtmlCaptureRequest, causeCode: string | null): Promise<void>;
}
