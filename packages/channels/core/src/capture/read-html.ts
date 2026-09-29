import {
  abortable,
  permittedUrl,
  requireCapability,
  transportAddress,
  type DnsResolver,
  type HttpRoute,
  type Response,
} from "@crawl-automation/v3-acquisition";
import type { HttpPolicy } from "../adapter.js";
import { channelErrors } from "../errors.js";

const challengeStatuses = new Set([403, 406, 429, 503]);
const goneStatuses = new Set([404, 410]);

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

/** Refuses anything but a plain, uncompressed HTML 200 answer. */
function checkResponse(response: Response): void {
  const refusal = statusRefusal(response.status);
  if (refusal) {
    throw channelErrors.create(refusal, { details: { status: response.status } });
  }
  if (!/^text\/html(?:\s*;|$)/i.test(response.headers["content-type"] ?? "")) {
    throw channelErrors.create("CAPTURE.NOT_HTML");
  }
  const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
  if (encoding && encoding !== "identity") {
    throw channelErrors.create("CAPTURE.ENCODING", { details: { encoding } });
  }
}

async function readBody(response: Response, maxBytes: number, signal: AbortSignal) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  for (;;) {
    signal.throwIfAborted();
    const next = await abortable(Promise.resolve(iterator.next()), signal);
    if (next.done) {
      break;
    }
    size += next.value.byteLength;
    if (size > maxBytes) {
      throw channelErrors.create("CAPTURE.PAGE_LIMIT", { details: { maxBytes } });
    }
    chunks.push(next.value);
  }
  if (size === 0) {
    throw channelErrors.create("CAPTURE.PAGE_NOT_DELIVERED");
  }
  return Buffer.concat(chunks);
}

export interface HtmlRequest {
  route: HttpRoute;
  url: string;
  policy: HttpPolicy;
  dns: DnsResolver;
}

/** One bounded GET of a public page through the configured route. No redirects, cookies or retries. */
export async function readHtmlBytes(request: HtmlRequest, abort: AbortSignal): Promise<Uint8Array> {
  const { route, policy, dns } = request;
  requireCapability(route, "http");
  const url = permittedUrl(request.url, policy.origins);
  const signal = AbortSignal.any([abort, AbortSignal.timeout(policy.timeoutMs)]);
  let response: Response | undefined;
  try {
    const address = await abortable(transportAddress(url, route.transport, dns, signal), signal);
    response = await abortable(
      route.transport.get(url, address, { accept: "text/html" }, signal),
      signal,
    );
    checkResponse(response);
    return await readBody(response, policy.maxBytes, signal);
  } finally {
    response?.close();
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
