import { z } from "zod";

/** Optional human pacing; existing readers keep their previous scrolling behaviour. */
export const PressDelaySchema = z
  .strictObject({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() })
  .refine((range) => range.max >= range.min, "Maximum delay must be at least the minimum");

export interface ListScroll {
  itemSelector: string;
  moreTexts: readonly string[];
  /** Opt-in controls with accessible labels, including next-page anchors; disabled controls are ignored. */
  moreSelector?: string;
  maxRounds: number;
  stableRounds: number;
  settleMs: number;
  /** Move over the list and wheel into view before a delayed in-page press. */
  pressDelayMs?: z.infer<typeof PressDelaySchema>;
}

/** Optional evidence fields keep archived none/stable/capped records readable. */
export const ListScrollResultSchema = z.object({
  rounds: z.number().int(),
  ended: z.enum(["none", "stable", "capped", "broken"]),
  seenCount: z.number().int().nonnegative().optional(),
  finalCount: z.number().int().nonnegative().optional(),
  missingCount: z.number().int().nonnegative().optional(),
  /** Original item fragments retained before disappearance; never substituted for the page HTML. */
  observedItems: z.array(z.object({ href: z.string(), html: z.string() })).optional(),
});
