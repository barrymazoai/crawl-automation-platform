import { z } from "zod";
import { ProductEvidenceJoinSchema } from "@crawl-automation/v3-contracts";
import { LabelPlanInputSchema } from "./label-plan-model.js";
import type { LabelProductManifest } from "@crawl-automation/v3-contracts";
import type { MergeFailure, VerifiedLabelSource } from "../assembly/label-merge.js";

export const OrderedProgressSchema = z.strictObject({
  input: LabelPlanInputSchema.refine((input) => !!input.sourcePolicy),
  states: z.array(ProductEvidenceJoinSchema.shape.states.element).max(100),
});
export type OrderedProgress = z.infer<typeof OrderedProgressSchema>;
export type OrderedState = OrderedProgress["states"][number];
export type OrderedSource = LabelProductManifest["sources"][number];
export interface SourceFailure {
  sourceId: string;
  code: string;
  executionFact: string;
  evidenceKey?: string | undefined;
}

export interface OrderedEvidence {
  sources: OrderedSource[];
  entries: VerifiedLabelSource[];
  failures: MergeFailure[];
  reasons: { failure: SourceFailure; progress: number }[];
  terminal: boolean;
}

export const OrderedSelectionSchema = OrderedProgressSchema.extend({
  selectedImageId: z.null(),
  states: z
    .array(
      z.union([
        ProductEvidenceJoinSchema.shape.states.element,
        z.strictObject({ id: z.string(), status: z.literal("not_started") }),
      ]),
    )
    .max(100),
});
