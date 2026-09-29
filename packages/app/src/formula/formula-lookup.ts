import type { FormulaKey } from "@crawl-automation/workflows";
import type { FormulaIndex } from "./ports.js";

/**
 * Channels whose listings share one product ID space for formulas. Whole Foods sells Amazon products under the same
 * ASIN, so a formula collected on either serves both. This is for the formula only: the 24-hour skip and the
 * metrics stay per channel.
 */
const FORMULA_FAMILIES: readonly (readonly string[])[] = [["amazon", "wholefoods"]];

/** The channels whose formulas this channel's products may use: its own, plus its formula family. */
export function formulaChannels(channel: string): string[] {
  const family = FORMULA_FAMILIES.find((members) => members.includes(channel));
  return family ? [...family] : [channel];
}

/** Formula once: the product's own formula (or one linked to it), across its formula family. */
export class FormulaLookup {
  constructor(private readonly index: Pick<FormulaIndex, "findKnown">) {}

  findKnown(key: FormulaKey): Promise<{ operationId: string } | null> {
    const { listingId, variantId } = key;
    return this.index.findKnown({ channels: formulaChannels(key.channel), listingId, variantId });
  }
}
