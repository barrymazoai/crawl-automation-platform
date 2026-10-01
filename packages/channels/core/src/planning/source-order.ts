import { convert } from "html-to-text";
import type { ChannelPlanInput } from "@crawl-automation/v3-contracts";

type SourcePolicy = NonNullable<ChannelPlanInput["sourcePolicy"]>;

/** Channel configuration chooses an order; no order is inferred from a merge-policy version. */
export function labelSourcePolicy(channel: string, order?: SourcePolicy["order"]): SourcePolicy {
  return {
    version: "label-sources/1",
    order:
      order ??
      (["amazon", "wholefoods-amazon-formula"].includes(channel) ? "images-first" : "text-first"),
  };
}

/** A label heading admits partial text too; marketing prose alone never admits a model call. */
export function hasLabelSection(html: string): boolean {
  const text = convert(html, { wordwrap: false });
  return /(?:^|\n)\s*(?:(?:Supplement|Nutrition|Drug)\s+Facts\b|(?:(?:Other|Inactive)\s+)?Ingredients\s*:)/im.test(
    text,
  );
}
