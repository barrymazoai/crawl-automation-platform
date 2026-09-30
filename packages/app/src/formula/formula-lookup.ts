import type { ChannelRegistry } from "@crawl-automation/channels-core";
import type { FormulaKey } from "@crawl-automation/workflows";
import type { FormulaFamilies, FormulaIndex } from "./ports.js";

/** Channels share formulas only when their adapters declare the same listing-ID namespace. */
export function formulaFamilies(registry: ChannelRegistry): FormulaFamilies {
  return {
    channels(channel) {
      const registered = registry.channels();
      const owner = registered.find((id) => id === channel);
      const family = owner ? registry.get(owner).formulaFamily : undefined;
      return family
        ? registered.filter((id) => registry.get(id).formulaFamily === family).sort()
        : [channel];
    },
  };
}

/** The channels whose formulas this channel's products may use, as declared by the adapters. */
export function formulaChannels(channel: string, families: FormulaFamilies): string[] {
  return families.channels(channel);
}

/** Formula once: the product's own formula (or one linked to it), across its formula family. */
export class FormulaLookup {
  constructor(
    private readonly index: Pick<FormulaIndex, "findKnown">,
    private readonly families: FormulaFamilies,
  ) {}

  findKnown(key: FormulaKey): Promise<{ operationId: string } | null> {
    const { listingId, variantId } = key;
    const channels = formulaChannels(key.channel, this.families);
    return this.index.findKnown({ channels, listingId, variantId });
  }
}
