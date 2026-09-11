import { z } from "zod";
import { ArtifactRefSchema, ExecutionIdSchema, Sha256Schema, VersionTagSchema } from "./artifacts.js";
import { ResourceGateSchema } from "./resources.js";
const id = ExecutionIdSchema;
const url = z.url().max(4096).refine(v => { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password && !u.hash; });
export const CatalogScopeSchema = z.strictObject({ brandId: id, sourceId: id, channel: z.enum(["gnc", "amazon", "swanson", "dtc"]),
  region: z.string().regex(/^[A-Z]{2}$/), rootUrl: url, scopeVersion: VersionTagSchema });
export type CatalogScope = z.infer<typeof CatalogScopeSchema>;
export const CatalogEntrySchema = z.strictObject({ listingId: id, variantId: id.nullable(), url, kind: z.enum(["product", "family"]) });
export const CatalogPageInputSchema = z.strictObject({ catalogId: id, scope: CatalogScopeSchema,
  page: z.number().int().min(0).max(100000), cursor: z.string().min(1).max(4096).nullable() });
export type CatalogPageInput = z.infer<typeof CatalogPageInputSchema>;
export const CatalogPageSchema = z.strictObject({ codec: z.literal("catalog-page/1"), input: CatalogPageInputSchema,
  // Explicit family-level directory coverage is not a negative SKU presence proof.
  familyCount:z.number().int().min(0).max(1000000).optional(),
  entries: z.array(CatalogEntrySchema).max(100), source: ArtifactRefSchema,
  nextCursor: z.string().min(1).max(4096).nullable(), completion: z.enum(["more", "complete", "unknown"]),
  // Completeness must be verified by the source adapter, not inferred from absent next links.
  endEvidence: ArtifactRefSchema.nullable(),
}).superRefine((p, c) => {
  if(p.familyCount!==undefined&&p.entries.some(e=>e.kind!=="family"||e.variantId!==null))c.addIssue({code:"custom",message:"Family count cannot describe SKU entries"});
  if ((p.completion === "more") !== (p.nextCursor !== null) || p.nextCursor !== null && p.nextCursor === p.input.cursor ||
      (p.completion === "complete") !== (p.endEvidence !== null)) c.addIssue({ code: "custom", message: "Invalid catalog continuation or closure" });
  for (const r of [p.source, p.endEvidence].filter(r => r !== null)) if (r.sourceId !== p.input.scope.sourceId)
    c.addIssue({ code: "custom", message: "Foreign catalog evidence" });
});
export type CatalogPage = z.infer<typeof CatalogPageSchema>;
export const CatalogDiscoverySchema = z.strictObject({ discoveryId: id, catalogId: id, scope: CatalogScopeSchema,
  entry: CatalogEntrySchema, source: ArtifactRefSchema, workflowId: id });
export type CatalogDiscovery = z.infer<typeof CatalogDiscoverySchema>;
export const CatalogCommitSchema = z.strictObject({ input: CatalogPageInputSchema, pageHash: Sha256Schema,
  discoveries: z.array(CatalogDiscoverySchema).max(100), nextCursor: z.string().min(1).max(4096).nullable(), completion: z.enum(["more", "complete", "unknown"]) });
export type CatalogCommit = z.infer<typeof CatalogCommitSchema>;
export const CatalogWorkflowInputSchema = z.strictObject({ catalogId: id, scope: CatalogScopeSchema,
  productWorkflow: z.enum(["CatalogProductWorkflow", "SwansonCatalogProductWorkflow", "AmazonCatalogProductWorkflow", "DtcCatalogProductWorkflow"]).optional(),
  resources:ResourceGateSchema.optional(),maxPages:z.number().int().min(1).max(100001).optional(),
  page: z.number().int().min(0).max(100000).default(0), cursor: z.string().min(1).max(4096).nullable().default(null),
  queues: z.strictObject({ source: VersionTagSchema, ledger: VersionTagSchema, product: VersionTagSchema }), pagesPerRun: z.number().int().min(1).max(10).default(5) });
export type CatalogWorkflowInput = z.infer<typeof CatalogWorkflowInputSchema>;
export const PresenceInputSchema = z.strictObject({ operationId: id, catalogId: id, scope: CatalogScopeSchema,
  listingId: id, variantId: id.nullable() });
export type PresenceInput = z.infer<typeof PresenceInputSchema>;
export const PresenceResultSchema = z.strictObject({ codec: z.literal("presence/1"), input: PresenceInputSchema,
  status: z.enum(["exists", "confirmed_absent", "unknown"]), code: VersionTagSchema, checkedAt: z.iso.datetime(),
  evidence: z.array(z.strictObject({ key: id, sha256: Sha256Schema })).max(2) });
export type PresenceResult = z.infer<typeof PresenceResultSchema>;
export const CatalogExecutionSchema = z.strictObject({ clusterId: id, namespace: id, workflowId: id, runId: z.uuid() });
