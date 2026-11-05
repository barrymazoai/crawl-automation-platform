import {
  PostgresChannelQueueStore,
  PostgresCrossMarketRecords,
  type PostgresMarketplaceReader,
  SupplySmartCrossMarketListings,
  type SupplySmartRpc,
} from "@crawl-automation/adapters";
import { CrossMarketCheck, QueuedCrossMarketRecapture, appErrors } from "@crawl-automation/app";
import {
  CodexTextConfigSchema,
  CodexVisionConfigSchema,
  crossMarketJudge,
} from "@crawl-automation/processing";
import type { CoreParts } from "./core-parts.js";

/**
 * KAN-243: the cross-market check of a storefront target's first listings. Its judgment is a tool-free turn of the
 * label model (processing.codex.vision's model and effort, owner 2026-11-05) on processing.codex.text's runtime.
 */
export function crossMarketCheck(
  parts: CoreParts,
  input: { rpc: SupplySmartRpc; reader: PostgresMarketplaceReader },
): CrossMarketCheck {
  const queue = new PostgresChannelQueueStore(parts.database);
  return new CrossMarketCheck({
    listings: new SupplySmartCrossMarketListings(input.rpc),
    material: {
      read: async (channel, listingIds, signal) =>
        (await input.reader.read({ channel, limit: listingIds.length, listingIds }, signal))
          .products,
    },
    judge: { judge: (request, signal) => judge(parts).judge(request, signal) },
    records: new PostgresCrossMarketRecords(parts.database),
    recapture: new QueuedCrossMarketRecapture({
      queue: {
        sourceOf: (channel, brandId) => queue.brandSourceOf(channel, brandId),
        add: (list) => queue.add(list),
      },
      productUrl: (channel, listingId) => {
        const productUrl = parts.registry.get(channel).productUrl;
        if (!productUrl) {
          throw appErrors.create("QUEUE.NOT_CONFIGURED");
        }
        return productUrl(listingId);
      },
    }),
  });
}

function judge(parts: CoreParts) {
  const codex = parts.config.processing?.codex;
  const vision = CodexVisionConfigSchema.parse(codex?.vision);
  const text = CodexTextConfigSchema.parse({
    ...CodexTextConfigSchema.parse(codex?.text),
    settings: vision.settings,
  });
  return crossMarketJudge({ text, environment: process.env });
}
