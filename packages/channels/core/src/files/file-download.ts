import { isAppError } from "@crawl-automation/platform";
import { ArtifactRefSchema, type FileAcquireInput } from "@crawl-automation/v3-contracts";
import { abortable } from "./abortable.js";
import { readFileBody } from "./file-body.js";
import { fileErrors } from "./file-errors.js";
import { inspectMedia } from "./file-media.js";
import { permittedUrl, transportAddress } from "./file-network.js";
import { acquiredImageId, fileHash, FILE_POLICY } from "./file-policy.js";
import type { DnsResolver, Response, SourceLease } from "./file-ports.js";
import { assertFileSession, safeHeaders } from "./file-session.js";

interface Download {
  input: FileAcquireInput;
  lease: SourceLease;
  dns: DnsResolver;
}
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function redirectedUrl(response: Response, url: URL, redirects: number): string {
  if (redirects >= FILE_POLICY.maxRedirects || !response.headers.location) {
    throw fileErrors.create("SOURCE.REDIRECT_LIMIT");
  }
  try {
    return new URL(response.headers.location, url).href;
  } catch (cause) {
    throw fileErrors.create("SOURCE.ORIGIN_BLOCKED", { cause });
  }
}

async function responseOf(pending: Promise<Response>, signal: AbortSignal): Promise<Response> {
  const guarded = pending
    .catch((cause: unknown) => {
      if (isAppError(cause)) {
        throw cause;
      }
      throw fileErrors.create("SOURCE.NETWORK_UNAVAILABLE", { cause });
    })
    .then((response) => {
      if (signal.aborted) {
        response.close();
        signal.throwIfAborted();
      }
      return response;
    });
  return abortable(guarded, signal);
}

function acquired(input: FileAcquireInput, response: Response, bytes: Buffer) {
  const digest = fileHash(bytes);
  if (input.expectedSha256 !== null && input.expectedSha256 !== digest) {
    throw fileErrors.create("ARTIFACT.INTEGRITY");
  }
  const media = inspectMedia(bytes, response.headers["content-type"], FILE_POLICY.maxPixels);
  const file = ArtifactRefSchema.parse({
    schemaVersion: 1,
    artifactId: acquiredImageId(input.operationId),
    observationId: input.observationId,
    sourceId: input.sourceId,
    listingId: input.listingId,
    variantId: input.variantId,
    kind: media.mediaType === "application/pdf" ? "source-pdf" : "source-image",
    mediaType: media.mediaType,
    sha256: digest,
    byteSize: bytes.length,
    objectKey: `v3/${input.observationId}/${input.operationId}/source`,
    producer: {
      operationId: input.operationId,
      module: input.module,
      implementationVersion: input.implementationVersion,
    },
  });
  return { input, file, bytes, dimensions: media.dimensions };
}

function activeSession(request: Download) {
  const transport = request.lease.transport;
  return () => {
    assertFileSession(request.lease, request.input);
    if (request.lease.transport !== transport) {
      throw fileErrors.create("SOURCE.SESSION_MISMATCH");
    }
  };
}

function sourceHeaders(lease: SourceLease, url: URL, initial: URL) {
  if (url.origin !== initial.origin) {
    return {};
  }
  return safeHeaders(
    lease.headersForUrl ? lease.headersForUrl(url.href) : lease.headersFor(url.origin),
  );
}

export async function downloadFile(request: Download, signal: AbortSignal) {
  const { lease, input, dns } = request;
  assertFileSession(lease, input);
  const transport = lease.transport;
  const origins = [...lease.allowedOrigins];
  const initial = permittedUrl(lease.url, origins);
  const active = activeSession(request);
  let url = initial;
  for (let redirects = 0; ; redirects++) {
    active();
    signal.throwIfAborted();
    const address = await abortable(transportAddress({ url, transport, dns }, signal), signal);
    active();
    const headers = sourceHeaders(lease, url, initial);
    const response = await responseOf(transport.get(url, address, headers, signal), signal);
    try {
      active();
      signal.throwIfAborted();
      if (redirectStatuses.has(response.status)) {
        url = permittedUrl(redirectedUrl(response, url, redirects), origins);
        continue;
      }
      if (response.status !== 200) {
        throw fileErrors.create("SOURCE.HTTP_STATUS");
      }
      const result = acquired(input, response, await readFileBody(response, signal, active));
      active();
      signal.throwIfAborted();
      return {
        ...result,
        redirects,
        artifactDurable: false as const,
        resultRegistered: false as const,
      };
    } finally {
      response.close();
    }
  }
}
