import { channelErrors } from "./errors.js";

/**
 * How a product page is fetched: through ScraperAPI (`http`). A browser (`browser`) is used only in the two cases the
 * owner approved (docs/spark/2026-09-28-channel-brand-adapters-plan.md): Amazon Store pages in brand scanning, and
 * Whole Foods, whose pages are drawn in the browser and priced by the chosen store. No other channel declares it.
 */
export type CaptureMode = "http" | "browser";

/** What a limited resource is. A permit's kind must match the work it guards. */
export type ResourceKind = "browser" | "http-lane" | "file-lane" | "model" | "ocr" | "cpu";

/** The resource a capture takes a permit on, with its kind. */
export interface CaptureLane {
  resourceId: string;
  kind: ResourceKind;
}

const laneKindFor: Record<CaptureMode, ResourceKind> = { http: "http-lane", browser: "browser" };

/** The permit kind a capture mode needs. */
export function captureLaneKind(mode: CaptureMode): ResourceKind {
  return laneKindFor[mode];
}

/**
 * Refuses a capture lane of the wrong kind. The Swanson pilot (2026-09-28) ran HTTP capture on a browser permit of
 * capacity 1, so 65 products queued single file; this check rejects that configuration at startup.
 */
export function assertCaptureLane(mode: CaptureMode, lane: CaptureLane): void {
  const needed = captureLaneKind(mode);
  if (lane.kind !== needed) {
    throw channelErrors.create("CHANNEL.CAPTURE_LANE_MISMATCH", {
      details: { mode, resourceId: lane.resourceId, kind: lane.kind, needed },
    });
  }
}
