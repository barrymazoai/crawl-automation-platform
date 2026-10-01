import { HTML_REUSE_WINDOW_MS, type HtmlCaptureRequest } from "./html-capture-model.js";
import type { HtmlCaptureRecords } from "./html-capture-records.js";
import type { OriginalHtmlArchive } from "./original-html-archive.js";

/** A stale in-flight record may already have an original in R2; inspect before paying. */
export async function recoverOriginal(
  deps: { archive: OriginalHtmlArchive; records: HtmlCaptureRecords | undefined },
  previous: HtmlCaptureRequest[],
  signal: AbortSignal,
) {
  for (const request of previous) {
    const original = await deps.archive.inspectPrevious(request, signal);
    if (original) {
      await deps.records?.complete(request, original);
      const age = Date.now() - Date.parse(original.capturedAt);
      if (age >= 0 && age < (deps.records?.reuseWindowMs ?? HTML_REUSE_WINDOW_MS)) {
        return original;
      }
    }
  }
  return null;
}
