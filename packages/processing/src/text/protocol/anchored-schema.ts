import { z } from "zod";

// Line ids are local to the selected range. Absolute UTF-16 offsets never come from the model.
const anchor = z.strictObject({
  fromLine: z.number().int().positive(),
  toLine: z.number().int().positive(),
  text: z.string().min(1).max(20000),
});

/** The anchored/2 answer format for source text: formula, ingredients and what was left out. */
export const AnchoredExtractionSchema = z.strictObject({
  formula: z
    .strictObject({
      servingSize: anchor.nullable(),
      nutrients: z
        .array(
          z.strictObject({
            name: anchor,
            amount: anchor.nullable(),
            dailyValue: anchor.nullable(),
          }),
        )
        .min(1)
        .max(200),
    })
    .nullable(),
  ingredients: z
    .strictObject({
      items: z
        .array(
          z.strictObject({
            quote: anchor,
            role: z.enum(["blend_component", "other"]),
            parentNutrientIndex: z.number().int().nonnegative().nullable(),
          }),
        )
        .min(1)
        .max(300),
    })
    .nullable(),
  excluded: z
    .array(
      z.strictObject({
        quote: anchor,
        reason: z.enum([
          "heading",
          "directions",
          "footnote",
          "allergen",
          "alternate_serving",
          "marketing",
          "noise",
        ]),
      }),
    )
    .max(500),
  issues: z.array(z.enum(["missing_text", "ambiguous_layout", "uncertain_role"])).max(3),
});
export type AnchoredExtraction = z.infer<typeof AnchoredExtractionSchema>;
