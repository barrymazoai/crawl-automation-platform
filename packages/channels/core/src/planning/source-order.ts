import { convert } from "html-to-text";
import type { ChannelPlanInput } from "@crawl-automation/v3-contracts";

type SourcePolicy = NonNullable<ChannelPlanInput["sourcePolicy"]>;

/** Channel configuration chooses an order; no order is inferred from a merge-policy version. */
export function labelSourcePolicy(channel: string, order?: SourcePolicy["order"]): SourcePolicy {
  return {
    version: "label-sources/1",
    order:
      order ??
      (["amazon", "wholefoods-amazon-formula", "dtc"].includes(channel)
        ? "images-first"
        : "text-first"),
  };
}

/**
 * A label heading admits partial text too; marketing prose alone never admits a model call.
 * GNC prints its facts table without a "Facts" heading ("Serving Size: 3 Capsules", "Other Ingredients").
 */
const LABEL_HEADING = new RegExp(
  [
    String.raw`(?:Supplement|Nutrition|Drug)\s+Facts\b`,
    String.raw`(?:(?:Other|Inactive)\s+)?Ingredients\s*:`,
    // Amazon's "Important information" prints a bare "Ingredients" heading line (owner 2026-10-05).
    String.raw`Ingredients\s*$`,
    String.raw`(?:Other|Inactive)\s+Ingredients\b`,
    String.raw`Serving\s+Size\s*:?\s*\d`,
    String.raw`Amount\s+Per\s+Serving\b`,
  ]
    .map((heading) => String.raw`(?:^|\n)\s*${heading}`)
    .join("|"),
  "im",
);

export function hasLabelSection(html: string): boolean {
  return LABEL_HEADING.test(convert(html, { wordwrap: false }));
}

const INGREDIENTS_HEADING = /(?:^|\n)\s*(?:(?:Other|Inactive)\s+)?Ingredients\s*(?::|$)/im;

/** A facts block that prints its own ingredient list ("Ingredients", "Other Ingredients:"). */
export function hasIngredientsSection(html: string): boolean {
  return INGREDIENTS_HEADING.test(convert(html, { wordwrap: false }));
}
