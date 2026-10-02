import type {
  BrowserCaptureResult,
  CaptureRequest,
  ProductSourcePlans,
  ArchivedHtml,
} from "@crawl-automation/channels-core";
import type { DtcVariantHandoff } from "@crawl-automation/v3-contracts";
import type { capturedProductProjection } from "./product-projection.js";
import { variantPages } from "./variant-pages.js";

export function nativeCaptureResult(
  input: Parameters<typeof captureResult>[0] & {
    variants: DtcVariantHandoff[] | undefined;
    currency: unknown;
  },
) {
  const result = captureResult(input);
  return input.variants
    ? {
        ...result,
        variants: input.variants,
        variantPages: variantPages({
          variants: input.variants,
          base: result.page,
          sourcePlan: input.sourcePlan,
          currency: input.currency,
        }),
      }
    : result;
}

function captureResult(input: {
  request: CaptureRequest;
  parsed: ReturnType<typeof capturedProductProjection>;
  sourcePlan: Awaited<ReturnType<ProductSourcePlans["publish"]>>;
  original: ArchivedHtml;
}): Extract<BrowserCaptureResult, { status: "captured" }> {
  const { request, parsed, sourcePlan, original } = input;
  const page = {
    channel: "dtc" as const,
    url: request.url,
    ...parsed.identity,
    externalId: parsed.identity.listingId,
    capturedAt: original.capturedAt,
    commerce: parsed.commerce,
    archive: { objectKey: original.source.objectKey, sha256: original.source.sha256 },
  };
  return {
    status: "captured",
    ...parsed.identity,
    archiveKey: page.archive.objectKey,
    page,
    planned: {
      status: "captured",
      sourcePlan,
      factsComplete: parsed.facts.complete,
      labelText: parsed.facts.text,
      family: null,
    },
  };
}
