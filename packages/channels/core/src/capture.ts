import { channelErrors } from "./errors.js";
import { RESOURCE_KINDS, type ResourceKind, type ResourceKindOf } from "./resource-kinds.js";

/**
 * How a product page is fetched: through ScraperAPI (`http`), or in an Ego browser (`browser`) only where the owner
 * decided so: Amazon Store pages in brand scanning and DTC sites (2026-09-30); whether Whole Foods needs it waits on
 * a fetch test (ticket R22).
 */
export type CaptureMode = "http" | "browser";

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

const LANE_KINDS: ReadonlySet<ResourceKind> = new Set(
  RESOURCE_KINDS.filter((kind) => Object.values(laneKindFor).includes(kind)),
);

/**
 * Checks a channel's capture gate (the permits `captureProduct` takes) against the modes the channel captures in:
 * each mode finds its lane among the needs, and every lane is one of those modes' lanes. Called at startup by the
 * process that holds the gates, so an HTTP capture paired with a browser permit never starts.
 */
export function assertCaptureGate(
  modes: readonly CaptureMode[],
  needs: readonly { resourceId: string }[],
  kindOf: ResourceKindOf,
): void {
  const lanes = needs
    .map((need) => ({ resourceId: need.resourceId, kind: kindOf(need.resourceId) }))
    .filter((lane) => LANE_KINDS.has(lane.kind));
  for (const lane of lanes) {
    if (!modes.some((mode) => captureLaneKind(mode) === lane.kind)) {
      assertCaptureLane(modes[0] ?? "http", lane);
    }
  }
  const missing = modes.filter(
    (mode) => !lanes.some((lane) => lane.kind === captureLaneKind(mode)),
  );
  if (missing.length > 0) {
    throw channelErrors.create("CHANNEL.CAPTURE_LANE_MISSING", {
      details: { modes: missing, needs: needs.map((need) => need.resourceId) },
    });
  }
}
