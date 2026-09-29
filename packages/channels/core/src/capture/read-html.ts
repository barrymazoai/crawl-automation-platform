import { channelErrors } from "../errors.js";

const challengeStatuses = new Set([403, 406, 429, 503]);
const goneStatuses = new Set([404, 410]);

/** What the page fetch answered, before its bytes count as a page. */
export interface PageAnswer {
  status: number;
  contentType: string | null;
  contentEncoding: string | null;
  bytes: Uint8Array;
}

/** The refusal code for a non-200 status, or null for 200. */
function statusRefusal(status: number) {
  if (status >= 300 && status < 400) {
    return "CAPTURE.REDIRECT_UNVERIFIED" as const;
  }
  if (challengeStatuses.has(status)) {
    return "CAPTURE.ACCESS_CHALLENGE" as const;
  }
  if (goneStatuses.has(status)) {
    return "CAPTURE.NOT_FOUND" as const;
  }
  return status === 200 ? null : ("CAPTURE.HTTP_STATUS" as const);
}

/** Refuses anything but a plain, uncompressed, non-empty HTML 200 answer. */
export function checkPage(answer: PageAnswer): void {
  const refusal = statusRefusal(answer.status);
  if (refusal) {
    throw channelErrors.create(refusal, { details: { status: answer.status } });
  }
  if (!/^text\/html(?:\s*;|$)/i.test(answer.contentType ?? "")) {
    throw channelErrors.create("CAPTURE.NOT_HTML");
  }
  const encoding = answer.contentEncoding?.trim().toLowerCase();
  if (encoding && encoding !== "identity") {
    throw channelErrors.create("CAPTURE.ENCODING", { details: { encoding } });
  }
  if (answer.bytes.byteLength === 0) {
    throw channelErrors.create("CAPTURE.PAGE_NOT_DELIVERED");
  }
}

/** Page bytes as text; a page that is not valid UTF-8 is refused rather than guessed. */
export function decodeHtml(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw channelErrors.create("CAPTURE.ENCODING", { cause: error });
  }
}
