import { currentMeasurement, recordMeasurement } from "@crawl-automation/platform";
import type { HtmlCaptureRequest, SavedHtmlOriginal } from "@crawl-automation/app";

/** Unknown remains null; an original reused by another operation incurs zero new credits. */
export function captureCreditCost(request: HtmlCaptureRequest, original: SavedHtmlOriginal | null) {
  if (original && original.capture.operationId !== request.capture.operationId) {
    return 0;
  }
  const events = currentMeasurement()?.events.filter((event) => event.kind === "capture") ?? [];
  if (!events.length || events.some((event) => event.creditCost === null)) {
    return null;
  }
  return events.reduce((total, event) => total + (event.creditCost ?? 0), 0);
}

export function captureWasCalled(): boolean {
  return (
    currentMeasurement()?.events.some((event) => event.kind === "capture" && event.providerCall) ??
    false
  );
}

export async function measureCaptureReuse(
  request: HtmlCaptureRequest,
  original: SavedHtmlOriginal,
) {
  await recordMeasurement({
    kind: "capture",
    step: "reuseHtml",
    channel: request.channel,
    operationId: request.capture.operationId,
    sourceId: request.capture.sourceId,
    sourceHash: original.source.sha256,
    cacheHit: true,
    providerCall: false,
    creditCost: 0,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    outcomeCode: "reused",
  });
}
