import { z } from "zod";

/** Observed in-page actions, retained alongside the exact rendered snapshot. */
export const PagePreparationSchema = z.object({
  expanded: z
    .array(
      z.object({
        kind: z.enum(["details", "accordion"]),
        target: z.string(),
        label: z.string(),
        revealed: z.boolean(),
      }),
    )
    .max(40),
  scrolls: z.number().int().nonnegative().max(12),
  pending: z.object({
    details: z.number().int().nonnegative(),
    toggles: z.number().int().nonnegative(),
    images: z.number().int().nonnegative(),
    panels: z.number().int().nonnegative(),
  }),
  blockedActions: z.number().int().nonnegative(),
  ended: z.enum(["stable", "capped"]),
  elapsedMs: z.number().nonnegative(),
});

export type PagePreparation = z.infer<typeof PagePreparationSchema>;
