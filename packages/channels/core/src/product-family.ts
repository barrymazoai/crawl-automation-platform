import { z } from "zod";

/**
 * What the members of a product family differ by, as the page shows it. Only `size` and `pack-count` may share a
 * formula (after a label check); a flavour, strength or form changes the label, and `unknown` is never assumed
 * to be harmless.
 */
export const FamilyDifferenceSchema = z.enum([
  "size",
  "pack-count",
  "flavour",
  "strength",
  "form",
  "unknown",
]);
export type FamilyDifference = z.infer<typeof FamilyDifferenceSchema>;

/** One other member of the family: its address and the option label the page shows for it. */
export const FamilyMemberSchema = z.strictObject({
  listingId: z.string().min(1).max(200),
  variantId: z.string().min(1).max(200).nullable(),
  url: z.url().max(4096),
  label: z.string().min(1).max(1000),
});
export type FamilyMember = z.infer<typeof FamilyMemberSchema>;

/**
 * The product's family as read from its own captured page: the other members, and what they differ by. The page
 * is the evidence; the adapter never guesses members the page does not show.
 */
export const ProductFamilySchema = z.strictObject({
  differsBy: FamilyDifferenceSchema,
  /** The option group the page names (e.g. "Size"), kept as evidence. */
  group: z.string().min(1).max(1000),
  /** The selected member's own option label. */
  selectedLabel: z.string().min(1).max(1000),
  members: z.array(FamilyMemberSchema).min(1).max(100),
});
export type ProductFamily = z.infer<typeof ProductFamilySchema>;

/** Strength units: a different amount per unit is a different formula, whatever the option group is called. */
const STRENGTH = /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|ug|iu|billion|cfu)\b/iu;
/** Counts of units in the container: capsules, tablets, gummies, servings and the like. */
const COUNT =
  /\b\d+\s*(?:ct|count|caps?|capsules?|veg ?caps?|vcaps?|tabs?|tablets?|softgels?|gels?|gummies|chews|lozenges|servings?|packets?|sticks?|pieces?)\b/iu;
/** Container weights and volumes. */
const WEIGHT = /\b\d+(?:[.,]\d+)?\s*(?:oz|fl\.? ?oz|lbs?|kg|g|grams?|ml|l|liters?)\b/iu;
const PACK = /\b(?:\d+\s*-?\s*pack|pack of \d+|\d+\s*x\b)/iu;
const FLAVOUR = /flavou?r/iu;
const FORM = /\bform\b/iu;

/** What one option label says it is. */
function labelKind(label: string): FamilyDifference {
  if (STRENGTH.test(label)) {
    return "strength";
  }
  if (PACK.test(label)) {
    return "pack-count";
  }
  return COUNT.test(label) || WEIGHT.test(label) ? "size" : "unknown";
}

/**
 * What a family's options differ by, from the option group's name and every option label. Conservative: any
 * option that does not read as a size or pack count makes the whole family something else.
 */
export function classifyFamily(group: string, labels: readonly string[]): FamilyDifference {
  if (FLAVOUR.test(group)) {
    return "flavour";
  }
  if (FORM.test(group)) {
    return "form";
  }
  const kinds = new Set(labels.map(labelKind));
  if (kinds.size === 1) {
    return [...kinds][0] ?? "unknown";
  }
  const sizeOnly = [...kinds].every((kind) => kind === "size" || kind === "pack-count");
  if (sizeOnly) {
    return "pack-count";
  }
  return kinds.has("strength") ? "strength" : "unknown";
}
