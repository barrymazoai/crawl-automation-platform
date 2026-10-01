import { z } from "zod";
import { AmazonFormulaRequestSchema } from "@crawl-automation/workflows";

/** Durable owner of metrics already captured; reconciliation never captures this page again. */
export const FamilyMetricsSchema = AmazonFormulaRequestSchema.shape.metrics.unwrap();
export type FamilyMetrics = z.infer<typeof FamilyMetricsSchema>;
export type FamilyFormulaStatus =
  "metrics-complete" | "formula-pending" | "no-amazon-source" | "formula-linked";
export interface FamilyFormulaOutcome extends FamilyMetrics {
  brandId: string;
  listingId: string;
  status: FamilyFormulaStatus;
  formulaOperationId: string | null;
}
export const FamilyFormulaQuerySchema = z.strictObject({
  operationIds: z.array(z.string().min(1).max(200)).min(1).max(100),
});
export type FamilyFormulaQuery = z.infer<typeof FamilyFormulaQuerySchema>;
export interface FamilyFormulaOutcomes {
  recordFamilyOutcome(outcome: FamilyFormulaOutcome): Promise<void>;
  familyOutcomes(query: FamilyFormulaQuery): Promise<FamilyFormulaOutcome[]>;
  findFamilyFormula(query: {
    channels: readonly string[];
    listingId: string;
    variantId: string | null;
  }): Promise<{ operationId: string } | null>;
}
