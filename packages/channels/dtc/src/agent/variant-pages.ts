import { schemaCommerce, type CapturedPage } from "@crawl-automation/channels-core";
import type { ChannelPlanInput, DtcVariantHandoff } from "@crawl-automation/v3-contracts";

/** Website commerce does not depend on whether the label/formula could be assigned. */
export function variantPages(input: {
  variants: DtcVariantHandoff[];
  base: CapturedPage;
  sourcePlan: ChannelPlanInput;
  currency: unknown;
}) {
  return input.variants.map((member) => {
    const { variant, operationId } = member;
    const source =
      member.status === "ready" ? member.planned.sourcePlan.source : input.sourcePlan.source;
    return {
      operationId,
      page: {
        ...input.base,
        url: variant.url,
        listingId: variant.listingId,
        variantId: variant.variantId,
        externalId: variant.listingId,
        commerce: schemaCommerce({
          ...variant,
          priceCurrency: input.currency,
          availability: variant.availability ?? variant.available,
        }),
        archive: { objectKey: source.objectKey, sha256: source.sha256 },
      },
    };
  });
}
