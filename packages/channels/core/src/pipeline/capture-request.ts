import type { ChannelPlanInput } from "@crawl-automation/v3-contracts";
import type { ChannelId } from "../adapter.js";

/** One product of one run, as the pipeline asks for it. */
export interface CaptureRequest {
  runId: string;
  channel: ChannelId;
  url: string;
  brandId: string;
  sourceId: string;
  /** Unique per product per run; names the archive, the projection and the plan. */
  operationId: string;
}

/** Which model and OCR settings the formula planner writes into its tasks, and the capture's egress. */
export type PlanSettings = Pick<ChannelPlanInput, "text" | "ocr" | "visionConfigFingerprint"> & {
  egressId: string;
  factsPolicy?: ChannelPlanInput["factsPolicy"];
};

export interface ProductCaptureResult {
  status: "captured";
  sourcePlan: ChannelPlanInput;
  /** Whether the page's own facts text is complete enough to read the formula without images. */
  factsComplete: boolean;
}
