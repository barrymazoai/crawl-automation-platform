import type { ChannelPlanInput, ReviewRecord } from "@crawl-automation/v3-contracts";

/** The workflow that collected an observation, so a product links back to its run. */
export interface ExecutionRef {
  clusterId: string;
  namespace: string;
  workflowId: string;
  runId: string;
}

export interface ExecutionRegistry {
  /** Records the execution once; a different execution for the same observation is a conflict. */
  register(observationId: string, execution: ExecutionRef): Promise<void>;
}

export interface ReviewLedger {
  read(reviewId: string): Promise<ReviewRecord | null>;
  append(record: ReviewRecord): Promise<unknown>;
}

/** Durable evidence in R2, written once and read back. */
export interface EvidencePublisher {
  publish(key: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal): Promise<void>;
}

/** The formula planner's saved plan for a product, when it exists and still matches its evidence. */
export interface PlanReader {
  inspect(sourcePlan: ChannelPlanInput, signal: AbortSignal): Promise<unknown>;
}
