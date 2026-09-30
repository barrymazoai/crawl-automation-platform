import {
  appErrors,
  type EvidenceCapture,
  type EvidenceCaptureRequest,
  type EvidenceChannels,
  type EvidencePages,
} from "@crawl-automation/app";
import { EvidenceArchive } from "./evidence-archive.js";

export interface HttpEvidenceCaptureParts {
  channels: EvidenceChannels;
  pages: EvidencePages;
  archive: EvidenceArchive;
}

/** The channel's normal HTTP capture, retaining bytes without invoking its product parser. */
export class HttpEvidenceCapture implements EvidenceCapture {
  constructor(private readonly parts: HttpEvidenceCaptureParts) {}

  async capture(request: EvidenceCaptureRequest, signal: AbortSignal) {
    if (request.maximumAttempts !== 1) {
      throw appErrors.create("EVIDENCE.SINGLE_REQUEST_UNAVAILABLE");
    }
    const adapter = this.parts.channels.forCapture(request.channel, "http");
    const address = adapter.productAddress(request.url);
    const pages = this.parts.pages();
    if (pages.mode !== "http") {
      throw appErrors.create("EVIDENCE.BROWSER_CAPTURE_UNSUPPORTED");
    }
    const target = { ...address, externalId: address.listingId };
    const reservation = await this.parts.archive.reserve(request, target, signal);
    const fetched = await pages.fetchPage(
      { channel: request.channel, url: address.url, policy: adapter.httpPolicy },
      signal,
    );
    return this.parts.archive.save(
      reservation,
      {
        bytes: fetched.bytes,
        finalUrl: fetched.fetchedVia.finalUrl ?? address.url,
        // ScraperApiPages accepts only HTML 200 answers; other statuses retain their channel error.
        status: 200,
        capturedAt: new Date().toISOString(),
        fetchedVia: fetched.fetchedVia,
      },
      signal,
    );
  }
}
