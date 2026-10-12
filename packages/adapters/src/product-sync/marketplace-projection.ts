import { productDeliveryErrors } from "@crawl-automation/app";
import type {
  MarketplaceChannels,
  MarketplaceHistory,
  MarketplaceProduct,
} from "@crawl-automation/app/marketplace-mapping";
import type { ObjectStore } from "@crawl-automation/platform";
import { retainedProjection } from "../product-delivery/retained-projection.js";

type ProjectionInput = Pick<MarketplaceProduct, "collection" | "enrichment" | "channel"> & {
  history: MarketplaceHistory;
};

/** The capture's parser owns identity recovery; a formula collection is not required to read its own page. */
export async function marketplaceProjection(
  deps: { objects: Pick<ObjectStore, "read">; channels: MarketplaceChannels },
  input: ProjectionInput,
  signal: AbortSignal,
) {
  const title = input.enrichment?.subject.titleEvidence;
  const product = await retainedProjection(
    {
      objects: deps.objects,
      references: [
        ...(title ? [{ objectKey: title.sourceId, sha256: title.sha256 }] : []),
        ...input.history.evidence,
      ],
      decode: (raw) => decodeProjection(deps.channels, input, raw),
    },
    signal,
  );
  if (!product) {
    throw productDeliveryErrors.create("PRODUCT_DELIVERY.MATERIAL_MISSING");
  }
  return product;
}

function decodeProjection(channels: MarketplaceChannels, input: ProjectionInput, raw: unknown) {
  const adapter = channels.get(input.channel);
  if (typeof raw === "string") {
    const parsed = adapter.parseProduct({
      html: raw,
      url: input.history.listing.url,
      capturedAt: input.history.capturedAt,
    });
    if (
      parsed.identity.listingId !== parsed.evidence.listingId ||
      parsed.identity.variantId !== parsed.evidence.variantId
    ) {
      throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
    }
    return parsed.evidence;
  }
  const planning = adapter.planning;
  const owner = input.collection?.observation ?? planning?.identity?.(raw);
  return owner && planning ? planning.read(raw, input.history.listing.url, owner).evidence : null;
}
