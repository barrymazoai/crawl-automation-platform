import { z } from "zod";
import { SourceOutcomesSchema } from "@crawl-automation/v3-contracts";
import type { Walk } from "./label-image-first.js";

export const SourceFailureSchema = z.strictObject({
  sourceId: z.string(),
  code: z.string(),
  executionFact: z.string(),
});

export interface OrderedWalk extends Walk {
  ordered: true;
  complete: boolean;
  reason?: z.infer<typeof SourceFailureSchema>;
}

/** An ordered label's progress report, with processing's bounded per-source outcomes. */
export const LabelProgressSchema = z.strictObject({
  input: z.unknown(),
  complete: z.boolean(),
  terminal: z.boolean(),
  reason: SourceFailureSchema.optional(),
  failures: z.array(SourceFailureSchema).max(100).optional(),
  sourceOutcomes: SourceOutcomesSchema.optional(),
});
