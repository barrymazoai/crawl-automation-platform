// The Supply Smart import contract. Trial / company link / product link / manifest schemas are a copy
// of supply-smart-mono packages/product-db/src/clinical-trial-import.ts at 3c6205c4 (KAN-217,
// SUPPLYSMAR-447); keep them in step with that file. Every delivered line is checked against them,
// so a run Supply Smart would skip lines of is never written.
//
// IngredientLinkSchema is the KAN-214 plan's draft (step 4b); Supply Smart has no importer for it yet.
import { z } from 'zod';

const NCT = z.string().regex(/^NCT\d{8}$/, 'not an NCT id');
const textOrNull = z.string().trim().min(1).nullish();
const textList = z.array(z.string()).nullish();

const CollaboratorSchema = z.union([z.string(), z.object({ name: z.string(), class: z.string().nullish() })]);
const InterventionSchema = z.object({
  name: z.string(),
  type: z.string().nullish(),
  description: z.string().nullish(),
  otherNames: z.array(z.string()).nullish(),
  armGroupLabels: z.array(z.string()).nullish(),
});
const OutcomeSchema = z.object({ measure: z.string(), description: z.string().nullish(), timeFrame: z.string().nullish() });

export const TrialRecordSchema = z.object({
  nct_id: NCT,
  title: textOrNull,
  official_title: textOrNull,
  overall_status: textOrNull,
  why_stopped: textOrNull,
  start_date: textOrNull,
  start_date_type: textOrNull,
  primary_completion_date: textOrNull,
  primary_completion_date_type: textOrNull,
  completion_date: textOrNull,
  completion_date_type: textOrNull,
  first_posted: textOrNull,
  last_update: textOrNull,
  study_type: textOrNull,
  phase: textList,
  primary_purpose: textOrNull,
  enrollment: z.number().int().nonnegative().nullish(),
  enrollment_type: textOrNull,
  conditions: textList,
  keywords: textList,
  interventions: z.array(InterventionSchema).nullish(),
  lead_sponsor: textOrNull,
  lead_sponsor_class: textOrNull,
  collaborators: z.array(CollaboratorSchema).nullish(),
  primary_outcomes: z.array(OutcomeSchema).nullish(),
  brief_summary: textOrNull,
  publications_linked: z.array(z.union([z.string(), z.number()])).nullish(),
  has_results: z.boolean().nullish(),
  source_url: textOrNull,
  raw: z.unknown().optional(),
});

const CONFIDENCE = z.enum(['high', 'medium', 'low']);

export const CompanyLinkSchema = z.object({
  nct_id: NCT,
  company_id: z.uuid(),
  role: z.enum(['lead_sponsor', 'collaborator']),
  matched_name: textOrNull,
  match_basis: z.enum(['sponsor_exact', 'sponsor_alias', 'manual']),
  confidence: CONFIDENCE,
});

export const ProductLinkSchema = z.object({
  nct_id: NCT,
  product_id: z.uuid(),
  intervention_name: textOrNull,
  match_basis: z.enum(['intervention_name', 'intervention_other_name', 'title', 'code_name_manual', 'manual']),
  confidence: CONFIDENCE,
});

export const ManifestSchema = z.object({
  run_id: z.string().min(1),
  fetched_at: z.string().min(1),
  source_db: z.string().min(1),
});

export const IngredientLinkSchema = z.object({
  nct_id: NCT,
  branded_ingredient_id: z.uuid(),
  external_key: textOrNull,
  match_basis: z.enum(['brand', 'alias', 'generic', 'active_compound']),
  matched_term: z.string().min(1),
  matched_field: z.string().min(1),
  evidence_quote: z.string(),
  role: z.enum(['sole', 'combination', 'comparator', 'unclear']),
  sponsor_is_supplier: z.boolean().nullable(),
  confidence: CONFIDENCE,
  review_note: textOrNull,
});

/** Parse or throw: a line outside the contract is a bug here, not something to deliver. */
export function checked(schema, row, what) {
  const parsed = schema.safeParse(row);
  if (!parsed.success) {
    throw new Error(`${what} ${row.nct_id ?? ''} is outside the import contract: ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`);
  }
  return row;
}
