import { z } from "zod";
import { textAnswer } from "../brand-research/text-runner.js";
import type { BrandTextDeps } from "../brand-research/settings.js";

/** The model's reasons, a fixed list so Supply Smart and the owner can count them. */
export const CROSS_MARKET_REASONS = [
  "same_formula_reworded",
  "same_brand_title_and_pack",
  "imported_original",
  "different_formula",
  "different_doses",
  "different_pack_or_form",
  "local_formulation",
  "insufficient_information",
] as const;

const SideSchema = z.strictObject({
  marketplace: z.string(),
  title: z.string().nullable(),
  brand: z.string().nullable(),
  servingSize: z.string().nullable(),
  servingsPerContainer: z.string().nullable(),
  rows: z.array(
    z.strictObject({
      name: z.string(),
      amount: z.string().nullable(),
      dailyValue: z.string().nullable(),
    }),
  ),
  otherIngredients: z.string().nullable(),
});
export type CrossMarketJudgeSide = z.infer<typeof SideSchema>;

const AnswerSchema = z.strictObject({
  verdict: z.enum(["same", "different", "unsure"]),
  reasons: z.array(z.enum(CROSS_MARKET_REASONS)).min(1).max(4),
});

export function crossMarketPrompt(input: {
  listing: CrossMarketJudgeSide;
  other: CrossMarketJudgeSide;
}): string {
  return [
    "Two Amazon storefronts list the same ASIN. Decide whether both listings are the same physical product",
    "(the same formulation in the same pack), using only the facts below: each side's page title and brand and its",
    "label as printed and transcribed (rows of ingredient and amount, serving size, other ingredients).",
    "",
    "Rules:",
    '- "same": the same product. An imported original with the other storefront\'s label, or the same formula',
    "  printed in another layout (per serving vs per 100 g, %RDA instead of %DV, reworded names, a missing optional",
    "  row), is the same product.",
    '- "different": another formulation or pack: an ingredient added or removed, a different dose per serving, a',
    "  different form or pack size, or a locally made version with its own formula.",
    '- "unsure": the facts do not settle it. Never guess.',
    "Give one to four reasons from the allowed list.",
    "",
    `Listing (${input.listing.marketplace}):`,
    JSON.stringify(SideSchema.parse(input.listing)),
    "",
    `Other storefront (${input.other.marketplace}):`,
    JSON.stringify(SideSchema.parse(input.other)),
  ].join("\n");
}

/**
 * KAN-243 (owner 2026-11-05): the cross-market judgment, one tool-free turn of the label model (the same model and
 * effort that read the labels). Its answer is checked against the fixed verdicts and reasons.
 */
export function crossMarketJudge(deps: BrandTextDeps) {
  const model = `${deps.text.settings.model}/${deps.text.settings.reasoningEffort}`;
  return {
    async judge(
      input: { listing: CrossMarketJudgeSide; other: CrossMarketJudgeSide },
      signal: AbortSignal,
    ) {
      const answer = await textAnswer(
        deps,
        { task: "cross-market", prompt: crossMarketPrompt(input), schema: AnswerSchema },
        signal,
      );
      return { verdict: answer.verdict, reasons: [...answer.reasons], model };
    },
  };
}
