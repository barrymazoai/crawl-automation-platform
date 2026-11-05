import { isAmazonChannel } from "@crawl-automation/v3-contracts";
import type { ChannelAdapter } from "../adapter.js";
import type { HtmlCaptureRecords } from "./html-capture-records.js";
import type { ArchivedHtml, OriginalHtmlArchive } from "./original-html-archive.js";
import { otherOfferRetryFailure } from "./other-offer-retry.js";

/** Replaying a capture makes the same first-versus-second choice as the original run. */
export async function existingOriginal(input: {
  adapter: ChannelAdapter;
  archive: OriginalHtmlArchive;
  records: HtmlCaptureRecords | undefined;
  signal: AbortSignal;
  readProduct: (archive: OriginalHtmlArchive, page: ArchivedHtml) => "page" | "sighting";
}) {
  const { adapter, archive, records, signal, readProduct } = input;
  const first = await archive.inspect(signal);
  if (!first) {
    return null;
  }
  let selected = { archive, page: first };
  let retryFailure: string | null = null;
  if (isAmazonChannel(adapter.id)) {
    const retryArchive = archive.otherOfferRetry();
    const retry = await retryArchive.inspect(signal);
    if (retry) {
      retryFailure = otherOfferRetryFailure({
        adapter,
        archive: retryArchive,
        page: retry,
        readProduct: () => readProduct(retryArchive, retry),
      });
      if (!retryFailure) {
        selected = { archive: retryArchive, page: retry };
      }
    }
  }
  await records?.complete(
    { channel: adapter.id, capture: archive.capture },
    selected.archive.reference(selected.page),
  );
  return {
    page: selected.page,
    ...(retryFailure ? { retryFailure } : {}),
  };
}
