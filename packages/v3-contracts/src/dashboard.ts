import { z } from "zod";
import { ExecutionIdSchema, ObservationSchema, Sha256Schema } from "./artifacts.js";
import { ReviewSchema } from "./processing.js";
const count = z.number().int().nonnegative();
export const DashboardSummarySchema = z.strictObject({ asOf: z.iso.datetime(), basis: z.literal("business-database"),
  discoveries: count, dispatchedProducts: count, pendingDispatches: count, processingResults: count, processedObservations: count,
  collectedProducts: count, collectedObservations: count, reviews: count, reviewObservations: count,
  formalWrites: z.null(), formalWriteStatus: z.literal("not-connected"),
  catalogs: z.strictObject({ open: count, complete: count, incomplete: count }),
  handoff: z.strictObject({ waiting: count, unknown: count }),
  errors: z.array(z.strictObject({ category: z.string(), code: z.string(), count })).max(200),
  sources: z.array(z.strictObject({ sourceId: z.string(), collected: count, reviews: count })).max(200),
});
export type DashboardSummary = z.infer<typeof DashboardSummarySchema>;
export const DashboardProductSchema = z.strictObject({ operationId: ExecutionIdSchema, observation: ObservationSchema,
  collectedAt: z.iso.datetime(), recordHash: Sha256Schema, formulaRows: count, otherIngredients: count,
  warningCodes: z.array(z.string()).max(1000), temporalUrl: z.url().nullable() });
export const DashboardProductsSchema = z.strictObject({ items: z.array(DashboardProductSchema).max(25), nextCursor: ExecutionIdSchema.nullable() });
export const PublicReviewSchema = z.strictObject({ reviewId: ExecutionIdSchema, occurredAt: z.iso.datetime(), registeredAt: z.iso.datetime(),
  failure: ReviewSchema, observation: ObservationSchema.nullable(), recordHash: Sha256Schema, inspectionKind: z.enum(["none", "workflow-delivery", "ocr-result"]),
  rawError: z.strictObject({ retained: z.literal(true), sha256: Sha256Schema }),
  candidate: z.strictObject({ retained: z.literal(true), sha256: Sha256Schema }).nullable() });
export const DashboardReviewsSchema = z.strictObject({ items: z.array(PublicReviewSchema).max(100), nextCursor: ExecutionIdSchema.nullable() });
