import { sha256 } from "@crawl-automation/platform";
import { z } from "zod";
import { OrderedProgressSchema } from "./ordered-model.js";
import { SourceOutcomesSchema } from "@crawl-automation/v3-contracts";

/** Immutable per-prefix report: no workflow input/result change and no mutable latest pointer. */
export function orderedProgressKey(input: { operationId: string }, states: unknown[]) {
  const attempted = states.filter(
    (state) =>
      !(typeof state === "object" && state && "status" in state && state.status === "not_started"),
  );
  const canonical = OrderedProgressSchema.shape.states.parse(attempted);
  const digest = sha256(Buffer.from(JSON.stringify(canonical)));
  return `v3/channel-labels/${input.operationId}/progress/${digest}.json`;
}

export const OrderedDiagnosticsSchema = z.object({
  request: OrderedProgressSchema,
  outcomes: z
    .array(
      z.object({
        sourceId: z.string(),
        status: z.string(),
        code: z.string().nullable(),
        codes: z.array(z.string()),
        missing: z.array(z.string()),
        evidenceKeys: z.array(z.string()),
      }),
    )
    .max(100),
  codes: z.array(z.string()),
  sourceOutcomes: SourceOutcomesSchema.optional(),
  /**
   * Owner 2026-10-21: every source's diagnostic as this round verified it, so the next round can reuse the verdicts
   * of images that matched no keyword or whose verified model answer showed no label sections.
   */
  sourceDiagnostics: z
    .array(
      z.object({
        sourceId: z.string(),
        kind: z.enum(["page", "image", "text"]),
        status: z.string(),
        reason: z.string(),
        detail: z.string().optional(),
        matchedKeywords: z.array(z.string()).optional(),
      }),
    )
    .max(100)
    .optional(),
});
export type OrderedDiagnostics = z.infer<typeof OrderedDiagnosticsSchema>;

/** The byte limit of one progress record. */
export const ORDERED_DIAGNOSTICS_LIMIT = 2 * 1024 * 1024;
