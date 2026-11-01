import type { ChannelAdapter, ParsedProduct } from "../adapter.js";
import { errorCodeOf } from "@crawl-automation/platform";
import type { ArchivedHtml, OriginalHtmlArchive } from "./original-html-archive.js";
import type { PageFetcher } from "./page-fetch.js";
import { isVerification } from "./challenge-escalation.js";
import { movedPage } from "./moved-page.js";

/** The first original remains immutable; the second has its own intent, receipt and verified bytes. */
export async function captureOtherOfferRetry(input: {
  pages: PageFetcher;
  adapter: ChannelAdapter;
  archive: OriginalHtmlArchive;
  first: ArchivedHtml;
  signal: AbortSignal;
  isOtherOffer: () => boolean;
}) {
  const { pages, adapter, archive, first, signal, isOtherOffer } = input;
  if (adapter.id !== "amazon" || !isOtherOffer()) {
    return null;
  }
  if (!pages.fetchOtherOfferRetry) {
    return null;
  }
  const retryArchive = archive.otherOfferRetry();
  await retryArchive.beginDownload(signal);
  const page = await pages
    .fetchOtherOfferRetry(
      { channel: adapter.id, url: archive.capture.url, policy: adapter.httpPolicy },
      signal,
    )
    .catch((error: unknown) => {
      return {
        retryFailure: errorCodeOf(error) ?? (error instanceof Error ? error.name : "UNKNOWN"),
      };
    });
  if ("retryFailure" in page) {
    return { status: "failed" as const, reason: page.retryFailure };
  }
  const saved = await retryArchive.save(
    page.bytes,
    { ...page.fetchedVia, otherOfferRetryOf: first.source },
    signal,
  );
  return { status: "captured" as const, archive: retryArchive, page: saved };
}

/** A verified archive is adopted only when it still names the requested product page. */
export function otherOfferRetryFailure(input: {
  adapter: ChannelAdapter;
  archive: OriginalHtmlArchive;
  page: ArchivedHtml;
  readProduct: () => "page" | "sighting";
}): string | null {
  const { adapter, archive, page, readProduct } = input;
  if (isVerification(adapter.httpPolicy, { ...page, url: archive.capture.url })) {
    return "CAPTURE.ACCESS_CHALLENGE";
  }
  try {
    if (movedPage(adapter, archive, page)) {
      return "CAPTURE.RETRY_MOVED";
    }
    return readProduct() === "page" ? null : "CAPTURE.RETRY_IDENTITY_CONFLICT";
  } catch (error) {
    return errorCodeOf(error) ?? (error instanceof Error ? error.name : "UNKNOWN");
  }
}

/** The warning goes into the captured commerce evidence and therefore into history extras. */
export function markOtherOfferRetryFailure(parsed: ParsedProduct, reason: string | undefined) {
  const conditions = parsed.commerce?.purchaseConditions;
  if (reason && conditions) {
    conditions.warnings = [
      ...new Set([`PURCHASE.OTHER_OFFER_RETRY_FAILED:${reason}`, ...conditions.warnings]),
    ].slice(0, 30);
  }
}

/** Decide once, then complete the parent reservation with the selected verified original. */
export async function resolveOtherOfferRetry(
  input: Parameters<typeof captureOtherOfferRetry>[0] & {
    readProduct: (archive: OriginalHtmlArchive, page: ArchivedHtml) => "page" | "sighting";
  },
) {
  const retry = await captureOtherOfferRetry(input);
  if (!retry) {
    return { page: input.first, archive: input.archive };
  }
  if (retry.status === "failed") {
    return { page: input.first, archive: input.archive, retryFailure: retry.reason };
  }
  const failure = otherOfferRetryFailure({
    adapter: input.adapter,
    archive: retry.archive,
    page: retry.page,
    readProduct: () => input.readProduct(retry.archive, retry.page),
  });
  return failure
    ? { page: input.first, archive: input.archive, retryFailure: failure }
    : { page: retry.page, archive: retry.archive };
}
