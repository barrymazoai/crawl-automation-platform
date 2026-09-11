import { z } from "zod";
import { GncAcquireInputSchema, GncAcquiredRecordSchema } from "./gnc-acquisition.js";
import { GncCatalogPageSchema } from "./gnc.js";
import { ExecutionIdSchema, ObjectKeySchema, Sha256Schema } from "./artifacts.js";
export const GncDiscoveryInputSchema = z.strictObject({ task: GncAcquireInputSchema.refine(t => t.capture.kind === "catalog-page"),
  index: z.number().int().min(0).max(999) });
export type GncDiscoveryInput = z.infer<typeof GncDiscoveryInputSchema>;
export const GncDiscoveryRecordSchema = z.strictObject({ codec: z.literal("gnc-discovery/1"), discoveryId: ExecutionIdSchema,
  input: GncDiscoveryInputSchema, capture: GncAcquiredRecordSchema,
  entry: GncCatalogPageSchema.shape.entries.element, total: z.number().int().min(1).max(1000),
  nextUrl: GncCatalogPageSchema.shape.nextUrl, completion: GncCatalogPageSchema.shape.completion });
export type GncDiscoveryRecord = z.infer<typeof GncDiscoveryRecordSchema>;
export const GncDiscoveryOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("published"), discoveryId: ExecutionIdSchema, index: z.number().int().nonnegative(),
    input: GncDiscoveryInputSchema,
    total: z.number().int().min(1).max(1000), evidenceKey: ObjectKeySchema, sha256: Sha256Schema,
    entry: GncCatalogPageSchema.shape.entries.element, nextUrl: GncCatalogPageSchema.shape.nextUrl,
    completion: GncCatalogPageSchema.shape.completion }),
  z.strictObject({ status: z.literal("review"), discoveryId: ExecutionIdSchema, index: z.number().int().nonnegative(),
    input: GncDiscoveryInputSchema,
    total: z.number().int().min(1).max(1000).nullable(), reviewId: ExecutionIdSchema, evidenceKey: ObjectKeySchema,
    code: z.string().min(1).max(160), automaticRetry: z.literal(false) }),
]);
export type GncDiscoveryOutcome = z.infer<typeof GncDiscoveryOutcomeSchema>;
export const GNC_DISCOVERY_QUEUE = "v3.gnc.discovery.v1.gnc-discovery-v1";
export const GNC_CATALOG_PAGE_QUEUE = "v3.gnc.catalog.page.v1.gnc-catalog-page-v1";
