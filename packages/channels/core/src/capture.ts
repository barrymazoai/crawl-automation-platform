import { channelErrors } from "./errors.js";

/** How a page is fetched: through an HTTP provider (ScraperAPI) or a real browser (Ego). */
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
