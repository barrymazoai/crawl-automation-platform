import { Id, type DeliveryIssue, type DeliveryReceipt } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { Channel } from "../delivery/delivery-coordinator.js";

/**
 * A run of one brand on one channel. Product and product-list runs are added with the shared channel
 * pipeline; until then single Amazon products go through the queue.
 */
export const SubmitRunSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("brand"),
    requestId: Id,
    brandId: Id,
    sourceId: Id,
    sourceRevision: z.number().int().positive().optional(),
  }),
]);
export type SubmitRun = z.infer<typeof SubmitRunSchema>;
export type BrandRun = Extract<SubmitRun, { kind: "brand" }>;

export const RunFilterSchema = z.strictObject({
  channel: z.enum(["amazon", "gnc", "swanson", "dtc"]).optional(),
  brandId: Id.optional(),
  active: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type RunFilter = z.infer<typeof RunFilterSchema>;

export interface RunSummary {
  runId: string;
  workflowId: string;
  channel: Channel;
  brandId: string;
  brandName: string;
  sourceId: string;
  createdAt: string;
  /** True while the run blocks new runs of the same source. */
  guardHeld: boolean;
  delivery:
    | (Pick<DeliveryReceipt, "state" | "observedStatus" | "closedAt"> & {
        lastIssue: DeliveryIssue | null;
      })
    | null;
}

export interface CatalogProgress {
  catalogPages: number;
  discovered: number;
  closure: "complete" | "incomplete" | null;
}

export interface WorkflowMember {
  workflowId: string;
  type: string;
  status: string;
  closedAt: Date | null;
}

export interface HeldPermit {
  permitId: string;
  workflowId: string;
  /** The owner's Temporal run ID, so its stop can be checked exactly. */
  runId: string;
  resources: string[];
  grantedAt: string;
}

export interface RunDetail extends RunSummary {
  progress: CatalogProgress;
  /** Workflow count per type and status, e.g. `{ SwansonCatalogProductWorkflow: { RUNNING: 12 } }`. */
  workflows: Record<string, Record<string, number>>;
  heldPermits: HeldPermit[];
}
