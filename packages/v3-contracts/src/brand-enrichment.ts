import { z } from "zod";

/**
 * Brand enrichment (owner 2026-10-08/09): shapes the crawler sends to and reads from Supply Smart, and the
 * crawler's own clues and decisions. Supply Smart shapes are copied from jakarta `dev` (SUPPLYSMAR-426/429):
 * `packages/api/src/schemas/brand-enrichment-schema.ts`, `packages/database-api/src/schemas/company-schema.ts`,
 * `company-ownership-schema.ts`, `contact-position-schema.ts`, `product-label-schema.ts`, `contact-schema.ts`.
 * Answers are read loosely (unknown keys kept), so a new field on their side never breaks a run.
 */

export const BRAND_ENRICHMENT_SOURCE = "brand_enrichment";

// ── Brand requests (biz API) ────────────────────────────────────────────────

export const BrandRequestStatusSchema = z.enum(["pending", "in_progress", "completed", "failed"]);

export const BrandRequestSchema = z.looseObject({
  id: z.uuid(),
  brandName: z.string(),
  brandUrl: z.string(),
  companyId: z.string().nullable(),
  status: BrandRequestStatusSchema,
  failureReason: z.string().nullable(),
  summary: z.record(z.string(), z.unknown()).nullable(),
});
export type BrandRequest = z.infer<typeof BrandRequestSchema>;

export const BrandRequestListSchema = z.looseObject({
  requests: z.array(BrandRequestSchema),
  statusCounts: z.record(BrandRequestStatusSchema, z.number()),
});

export const FamilyShapeSchema = z.enum(["single", "separate_sites", "shared_site", "holding"]);
export type FamilyShape = z.infer<typeof FamilyShapeSchema>;

export const SubBrandOutcomeSchema = z.enum([
  "completed",
  "failed",
  "skipped_not_nutrition",
  "over_limit",
]);

/** What the run did; stored on the request and shown on the admin page (spec §2.9). */
export const BrandEnrichmentSummarySchema = z.object({
  products: z
    .object({ captured: z.number().int().min(0), review: z.number().int().min(0) })
    .partial()
    .optional(),
  profile: z.enum(["filled", "kept_existing", "missing"]).optional(),
  apollo: z
    .object({
      status: z.enum(["matched", "parent_only", "no_match"]),
      by: z.string().optional(),
      attempts: z.number().int().min(0).optional(),
    })
    .optional(),
  contacts: z.number().int().min(0).optional(),
  ownership: z.enum(["has_parent", "independent", "waiting_for_person"]).optional(),
  family: z
    .object({
      shape: FamilyShapeSchema,
      subBrands: z.array(
        z.object({
          name: z.string().trim().min(1).max(200),
          companyId: z.string().nullable().optional(),
          status: SubBrandOutcomeSchema,
        }),
      ),
    })
    .optional(),
});
export type BrandEnrichmentSummary = z.infer<typeof BrandEnrichmentSummarySchema>;

export const BrandRequestUpdateSchema = z.discriminatedUnion("status", [
  z.object({ id: z.uuid(), status: z.literal("in_progress") }),
  z.object({
    id: z.uuid(),
    status: z.literal("completed"),
    companyId: z.uuid(),
    summary: BrandEnrichmentSummarySchema,
  }),
  z.object({
    id: z.uuid(),
    status: z.literal("failed"),
    reason: z.string().trim().min(1).max(1000),
    summary: BrandEnrichmentSummarySchema.optional(),
  }),
]);
export type BrandRequestUpdate = z.infer<typeof BrandRequestUpdateSchema>;

// ── Companies (database API) ────────────────────────────────────────────────

/** `product/resolveCompany`: by domain only. */
export const DomainResolutionSchema = z.looseObject({
  status: z.enum(["matched", "unmatched", "ambiguous", "conflict"]),
  companyId: z.string().nullable(),
  companyName: z.string().nullable(),
  candidates: z.array(z.looseObject({ id: z.string(), name: z.string() })),
  reason: z.string(),
});
export type DomainResolution = z.infer<typeof DomainResolutionSchema>;

export const CompanyFactsSchema = z
  .object({
    name: z.string().trim().min(1).max(500).optional(),
    domain: z.string().trim().min(1).max(500).optional(),
    apolloOrganizationId: z.string().trim().min(1).max(200).optional(),
  })
  .refine((facts) => facts.name || facts.domain || facts.apolloOrganizationId, {
    message: "At least one of name, domain, apolloOrganizationId is required",
  });
export type CompanyFacts = z.infer<typeof CompanyFactsSchema>;

/** `company/resolve`: domain → Apollo id → normalized legal name; never picks when unsure. */
export const CompanyResolutionSchema = z.looseObject({
  status: z.enum(["matched", "unmatched", "ambiguous"]),
  companyId: z.string().nullable(),
  matchedBy: z.string().nullable(),
  matches: z.array(
    z.looseObject({ companyId: z.string(), name: z.string(), matchedBy: z.string() }),
  ),
  reason: z.string(),
});
export type CompanyResolution = z.infer<typeof CompanyResolutionSchema>;

export const NewCompanySchema = z.object({
  name: z.string().trim().min(1).max(500),
  /** Absent for a brand line sold only on a group's site. */
  website: z.string().trim().min(1).optional(),
  isNutrition: z.boolean(),
});
export type NewCompany = z.infer<typeof NewCompanySchema>;

export const CompanySchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  description: z.string().nullable().optional(),
  keywords: z.array(z.string()).nullable().optional(),
  apolloOrganizationId: z.string().nullable().optional(),
});
export type Company = z.infer<typeof CompanySchema>;

export const DomainAdditionSchema = z.object({
  companyId: z.uuid(),
  domains: z
    .array(
      z.object({
        domain: z.string().trim().min(1).max(500),
        status: z.enum(["current", "former"]),
        redirectsTo: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type DomainAddition = z.infer<typeof DomainAdditionSchema>;

export const DomainAdditionResultSchema = z.looseObject({
  added: z.array(z.string()),
  existing: z.array(z.string()),
  conflicts: z.array(z.object({ domain: z.string(), ownerCompanyId: z.string() })),
  skipped: z.array(z.object({ domain: z.string(), reason: z.string() })),
});
export type DomainAdditionResult = z.infer<typeof DomainAdditionResultSchema>;

/** The five `company_category` names; enrich refuses anything else. */
export const CompanyCategorySchema = z.enum([
  "pharmacy",
  "nutrition",
  "food",
  "beverage",
  "beauty/personal care",
]);

export const ApolloTieSchema = z.enum(["domain", "former_domain", "linkedin", "name_address"]);
export type ApolloTie = z.infer<typeof ApolloTieSchema>;

export const ApolloOrganizationSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().nullish(),
  website_url: z.string().nullish(),
  primary_domain: z.string().nullish(),
  linkedin_url: z.string().nullish(),
  raw_address: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  country: z.string().nullish(),
});
export type ApolloOrganization = z.infer<typeof ApolloOrganizationSchema>;

export const ApolloPersonSchema = z.looseObject({
  id: z.string().nullish(),
  name: z.string().nullish(),
  first_name: z.string().nullish(),
  last_name: z.string().nullish(),
  title: z.string().nullish(),
  organization_id: z.string().nullish(),
});
export type ApolloPerson = z.infer<typeof ApolloPersonSchema>;

export const EvidencePageSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  observedAt: z.string().trim().min(1).max(64),
});

/** `company/enrich` as this pipeline sends it: fill empty fields only, never a hidden employer. */
export const CompanyEnrichmentSchema = z.object({
  companyId: z.uuid(),
  description: z.string().trim().min(1).optional(),
  keywords: z.array(z.string().trim().min(1)).optional(),
  categories: z.array(CompanyCategorySchema).optional(),
  evidence: z.array(EvidencePageSchema).max(50).optional(),
  apollo: z
    .object({
      organization: ApolloOrganizationSchema,
      match: z.object({
        by: ApolloTieSchema,
        attempts: z.number().int().min(1).max(3),
        note: z.string().trim().max(2000).optional(),
      }),
      people: z.array(ApolloPersonSchema),
    })
    .optional(),
});
export type CompanyEnrichment = z.infer<typeof CompanyEnrichmentSchema>;

export const CompanyEnrichmentResultSchema = z.looseObject({
  matched: z.boolean(),
  companyId: z.string().nullable(),
  updatedFields: z.array(z.string()),
  skippedFields: z.array(z.string()),
  categories: z.object({ added: z.number(), existing: z.number() }),
  contacts: z.looseObject({ inserted: z.number(), skipped: z.number() }),
  apolloOrganizationHeldBy: z.string().nullable(),
  routed: z.array(
    z.object({
      companyId: z.string(),
      created: z.boolean(),
      inserted: z.number(),
      skipped: z.number(),
    }),
  ),
});
export type CompanyEnrichmentResult = z.infer<typeof CompanyEnrichmentResultSchema>;

export const OwnershipKindSchema = z.enum(["brand_of", "subsidiary_of"]);
export type OwnershipKind = z.infer<typeof OwnershipKindSchema>;

export const CompanyLinkSchema = z.object({
  fromCompanyId: z.uuid(),
  toCompanyId: z.uuid(),
  kind: OwnershipKindSchema,
  confidence: z.number().min(0).max(1),
});
export type CompanyLink = z.infer<typeof CompanyLinkSchema>;

export const CompanyLinkResultSchema = z.looseObject({
  status: z.enum(["created", "existing"]),
  relationshipId: z.string(),
  apolloOrganizationMoved: z
    .looseObject({
      apolloOrganizationId: z.string(),
      fieldsCleared: z.array(z.string()),
      contactsMoved: z.number(),
    })
    .nullable(),
});
export type CompanyLinkResult = z.infer<typeof CompanyLinkResultSchema>;

export const CompanyUnlinkSchema = z.object({
  fromCompanyId: z.uuid(),
  toCompanyId: z.uuid(),
  kind: OwnershipKindSchema,
  reason: z.string().trim().min(1).max(2000),
});
export type CompanyUnlink = z.infer<typeof CompanyUnlinkSchema>;

export const OwnershipCheckSchema = z.object({
  companyId: z.uuid(),
  /** Final results only: "can't tell" stays in the crawler. */
  result: z.enum(["has_parent", "independent"]),
  signals: z.array(z.string().trim().min(1).max(100)).max(50),
  note: z.string().trim().max(2000).optional(),
});
export type OwnershipCheck = z.infer<typeof OwnershipCheckSchema>;

export const OwnershipStatusSchema = z.looseObject({
  latestCheck: z
    .looseObject({ checkedAt: z.string(), result: z.string(), signals: z.array(z.string()) })
    .nullable(),
  owners: z.array(
    z.looseObject({ toCompanyId: z.string(), name: z.string(), kind: OwnershipKindSchema }),
  ),
});
export type OwnershipStatus = z.infer<typeof OwnershipStatusSchema>;

// ── Contacts (database API) ─────────────────────────────────────────────────

export const ContactSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  position: z.string().nullable(),
  title: z.string().nullable(),
  contactPositionLevel: z.string().nullable(),
  contactPositionFunction: z.string().nullable(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const PositionTaxonomySchema = z.object({
  functions: z.array(z.string()).min(1),
  levels: z.array(z.string()).min(1),
});
export type PositionTaxonomy = z.infer<typeof PositionTaxonomySchema>;

export const KnownPositionSchema = z.looseObject({
  title: z.string(),
  normalizedTitle: z.string(),
  status: z.enum(["known", "conflicting", "unknown"]),
  function: z.string().nullable(),
  level: z.string().nullable(),
  seenCount: z.number(),
  share: z.number(),
});
export type KnownPosition = z.infer<typeof KnownPositionSchema>;

export const PositionClassificationSchema = z.object({
  contactId: z.uuid(),
  function: z.string().min(1),
  level: z.string().min(1),
  method: z.enum(["reused", "codex"]),
});
export type PositionClassification = z.infer<typeof PositionClassificationSchema>;

export const PositionClassificationResultSchema = z.looseObject({
  updated: z.number(),
  skipped: z.number(),
});

/** Same rule as Supply Smart's `normalizePositionTitle`: lowercase, punctuation → space, collapse, trim. */
export function normalizePositionTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ── The crawler's own clues and decisions (never sent to Supply Smart) ──────

export const OwnershipSignalSchema = z.enum([
  "domain_redirect",
  "website_our_brands",
  "website_footer",
  "web_search",
  "apollo_parent",
  "apollo_suborganization",
  "shared_apollo_org",
]);
export type OwnershipSignal = z.infer<typeof OwnershipSignalSchema>;

/** Strong signals are enough on their own; the reviewer weighs the rest. */
export const STRONG_OWNERSHIP_SIGNALS: readonly OwnershipSignal[] = [
  "domain_redirect",
  "website_our_brands",
];

export const OwnershipClueSchema = z.object({
  signal: OwnershipSignalSchema,
  ownerName: z.string().trim().min(1).max(500),
  ownerDomain: z.string().trim().min(1).max(500).nullable(),
  /** Supply Smart company, when one is already known (e.g. the holder of a shared Apollo id). */
  ownerCompanyId: z.uuid().nullable(),
  quote: z.string().trim().max(2000),
  url: z.string().trim().max(2000).nullable(),
  /** Saved page (archive key + sha256), when the clue came from a page. */
  archiveKey: z.string().nullable(),
});
export type OwnershipClue = z.infer<typeof OwnershipClueSchema>;

export const ReviewerVerdictSchema = z.discriminatedUnion("verdict", [
  z.object({
    verdict: z.literal("owner"),
    ownerName: z.string().trim().min(1).max(500),
    ownerDomain: z.string().trim().min(1).max(500).nullable(),
    kind: OwnershipKindSchema,
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1).max(4000),
    signals: z.array(OwnershipSignalSchema).min(1),
  }),
  z.object({
    verdict: z.literal("independent"),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1).max(4000),
  }),
  z.object({
    verdict: z.literal("cannot_tell"),
    reason: z.string().trim().min(1).max(4000),
  }),
]);
export type ReviewerVerdict = z.infer<typeof ReviewerVerdictSchema>;

// ── Runs as the crawler stores them ─────────────────────────────────────────

export const BrandEnrichmentRoleSchema = z.enum(["request", "sub_brand", "owner"]);
export type BrandEnrichmentRole = z.infer<typeof BrandEnrichmentRoleSchema>;

export const BrandEnrichmentStateSchema = z.enum([
  "running",
  "waiting_for_person",
  "completed",
  "failed",
  "cancelled",
]);

export const BrandEnrichmentRunSchema = z.object({
  runId: z.uuid(),
  requestId: z.uuid().nullable(),
  parentRunId: z.uuid().nullable(),
  role: BrandEnrichmentRoleSchema,
  brandName: z.string(),
  brandUrl: z.string().nullable(),
  companyId: z.uuid().nullable(),
  workflowId: z.string(),
  state: BrandEnrichmentStateSchema,
  stage: z.string().nullable(),
  summary: BrandEnrichmentSummarySchema.nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type BrandEnrichmentRun = z.infer<typeof BrandEnrichmentRunSchema>;

export const BrandEnrichmentQuestionKindSchema = z.enum([
  "ownership",
  "merge",
  "link_conflict",
  "identity",
]);

export const BrandEnrichmentQuestionSchema = z.object({
  questionId: z.uuid(),
  runId: z.uuid(),
  kind: BrandEnrichmentQuestionKindSchema,
  question: z.record(z.string(), z.unknown()),
  state: z.enum(["open", "answered", "dismissed"]),
  answer: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.coerce.date(),
});
export type BrandEnrichmentQuestion = z.infer<typeof BrandEnrichmentQuestionSchema>;

export const StoredDecisionSchema = z.object({
  decisionId: z.uuid(),
  runId: z.uuid(),
  verdict: z.enum(["owner", "independent", "cannot_tell"]),
  ownerCompanyId: z.uuid().nullable(),
  kind: OwnershipKindSchema.nullable(),
  confidence: z.coerce.number().nullable(),
  reason: z.string(),
  signals: z.array(OwnershipSignalSchema),
  decidedBy: z.string(),
  sent: z.record(z.string(), z.unknown()).nullable(),
  spotCheck: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.coerce.date(),
});
export type StoredDecision = z.infer<typeof StoredDecisionSchema>;
