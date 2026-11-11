import {
  PostgresChannelQueueStore,
  PostgresCrossMarketRecords,
  PostgresLabelTranslations,
  type PostgresMarketplaceReader,
  SupplySmartCrossMarketListings,
  type SupplySmartRpc,
} from "@crawl-automation/adapters";
import {
  CrossMarketCheck,
  LabelTranslation,
  QueuedCrossMarketRecapture,
  appErrors,
} from "@crawl-automation/app";
import {
  CodexTextConfigSchema,
  CodexVisionConfigSchema,
  crossMarketJudge,
  labelTranslator,
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
    log: (error) =>
      parts.log.warn(
        { err: error, service: "cross-market" },
        "cross-market judgment failed; retried next round",
      ),
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
  return crossMarketJudge(labelModel(parts));
}

/**
 * KAN-243: a label's printed German translated into English before it is sent (owner 2026-11-11, Germany plan option
 * A), by the same tool-free turn of the label model as the cross-market judgment.
 */
export function labelTranslation(parts: CoreParts): LabelTranslation {
  return new LabelTranslation({
    store: new PostgresLabelTranslations(parts.database),
    translator: {
      translate: (input, signal) => labelTranslator(labelModel(parts)).translate(input, signal),
    },
    log: (error) =>
      parts.log.warn(
        { err: error, service: "label-translation" },
        "label translation failed; products wait for the next round",
      ),
  });
}

/** The label model (processing.codex.vision's model and effort) on processing.codex.text's runtime. */
function labelModel(parts: CoreParts) {
  const codex = parts.config.processing?.codex;
  const vision = CodexVisionConfigSchema.parse(codex?.vision);
  const text = CodexTextConfigSchema.parse({
    ...CodexTextConfigSchema.parse(codex?.text),
    settings: vision.settings,
  });
  return { text, environment: process.env };
}
