import { z } from "zod";

/**
 * Why each source of an ordered label produced no label, kept small for the Review: written by processing, carried
 * through the label workflow's progress report and copied into the Review by the application (2026-10-12).
 */
export const SourceOutcomesSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  omitted: z.number().int().nonnegative(),
  sources: z
    .array(
      z.strictObject({
        sourceId: z.string().max(128),
        kind: z.enum(["page", "image", "text"]),
        status: z.string().max(24),
        reason: z.string().max(120),
        detail: z.string().max(240).optional(),
        matchedKeywords: z.array(z.string().max(48)).max(6).optional(),
      }),
    )
    .max(20),
});
export type SourceOutcomes = z.infer<typeof SourceOutcomesSchema>;
