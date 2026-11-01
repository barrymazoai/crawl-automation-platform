import type { ChannelAdapter } from "../adapter.js";
import { channelErrors } from "../errors.js";
import type { ArchivedHtml, OriginalHtmlArchive } from "./original-html-archive.js";
import type { PageFetcher } from "./page-fetch.js";

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
      // The first archived page already proved the listing exists; a failed second exit cannot delist it.
      throw channelErrors.create("CAPTURE.DOWNLOAD_UNRESOLVED", { cause: error });
    });
  const saved = await retryArchive.save(
    page.bytes,
    { ...page.fetchedVia, otherOfferRetryOf: first.source },
    signal,
  );
  return { archive: retryArchive, page: saved };
}
