import {
  ChannelIdSchema,
  Id,
  type DeliveryIssue,
  type DeliveryReceipt,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { Channel } from "../delivery/delivery-coordinator.js";

/**
 * A run of one brand on one channel, or of one product page. A product run's channel and brand come from its
 * source; its URL must be a product page of that channel. Single Amazon products still go through the queue.
 */
export const SubmitRunSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("brand"),
    requestId: Id,
    brandId: Id,
    sourceId: Id,
    sourceRevision: z.number().int().positive().optional(),
  }),
  z.strictObject({
    kind: z.literal("product"),
    requestId: Id,
    sourceId: Id,
    url: z.url({ protocol: /^https$/ }).max(4096),
  }),
]);
export type SubmitRun = z.infer<typeof SubmitRunSchema>;
export type BrandRun = Extract<SubmitRun, { kind: "brand" }>;
export type ProductRun = Extract<SubmitRun, { kind: "product" }>;

export const RunFilterSchema = z.strictObject({
  channel: ChannelIdSchema.optional(),
  brandId: Id.optional(),
  active: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
export type RunFilter = z.infer<typeof RunFilterSchema>;

export interface RunSummary {
  kind: "brand" | "product";
  runId: string;
  workflowId: string;
  channel: Channel;
  brandId: string;
  brandName: string;
  sourceId: string;
  /** The product page of a product run; null for a brand run. */
  url: string | null;
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
  /** Why the catalog closed incomplete, e.g. `RESOURCE.WAIT_LIMIT`; null when complete or still open. */
  closureFailure: string | null;
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
