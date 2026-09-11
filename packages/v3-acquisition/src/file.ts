import { ArtifactRefSchema, FileAcquireInputSchema, type ArtifactRef, type FileAcquireInput } from "@crawl-automation/v3-contracts";
import { AcquisitionError, type DnsResolver, type SourceAccess, type SourceLease, type Response } from "./ports.js";
import { abortable, hash, verifyInput } from "./core.js";
import { permittedUrl, transportAddress } from "./network.js";
import { inspectMedia } from "./media.js";
export const FILE_POLICY = Object.freeze({ maxBytes: 32 * 1024 * 1024, maxPixels: 40000000, maxRedirects: 3, timeoutMs: 30000 });
export const FILE_CONFIG_FINGERPRINT = hash(JSON.stringify(["file.acquire/1", FILE_POLICY]));
export type AcquiredFile = {
    input: FileAcquireInput;
    file: ArtifactRef;
    bytes: Uint8Array;
    dimensions: {
        width: number;
        height: number;
    } | null;
    redirects: number;
    artifactDurable: false;
    resultRegistered: false;
};
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
function session(lease: SourceLease, input: FileAcquireInput) {
    try {
        lease.assertActive();
    }
    catch (error) {
        if (error instanceof AcquisitionError)
            throw error;
        throw new AcquisitionError("SOURCE.SESSION_UNAVAILABLE");
    }
    for (const field of ["schemaVersion", "requestId", "observationId", "brandId", "sourceId", "listingId", "variantId"] as const)
        if (lease.owner[field] !== input[field])
            throw new AcquisitionError("SOURCE.SESSION_MISMATCH");
    if (lease.sourceId !== input.sourceId || lease.resourceId !== input.resourceId || lease.binding.sessionId !== input.binding.sessionId ||
        lease.binding.egressId !== input.binding.egressId || lease.transport.egressId !== input.binding.egressId)
        throw new AcquisitionError("SOURCE.SESSION_MISMATCH");
}
function safeHeaders(raw: Readonly<Record<string, string>>): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
        const name = key.toLowerCase();
        if (!["cookie", "authorization", "user-agent", "accept", "referer"].includes(name) || headers[name] ||
            typeof value !== "string" || value.length > 8192 || /[\r\n\0]/.test(value))
            throw new AcquisitionError("SOURCE.SESSION_MISMATCH");
        headers[name] = value;
    }
    return headers;
}
async function readBody(response: Response, signal: AbortSignal, active: () => void) {
    const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
    if (encoding && encoding !== "identity")
        throw new AcquisitionError("SOURCE.ENCODING");
    const length = response.headers["content-length"];
    if (length !== undefined && !/^\d+$/.test(length))
        throw new AcquisitionError("ARTIFACT.INTEGRITY");
    const expected = length === undefined ? null : Number(length);
    if (expected !== null && (!Number.isSafeInteger(expected) || expected > FILE_POLICY.maxBytes))
        throw new AcquisitionError("ARTIFACT.TOO_LARGE");
    const chunks: Buffer[] = [];
    let size = 0;
    const iterator = response.body[Symbol.asyncIterator]();
    try {
        while (true) {
            active();
            const chunk = await abortable(iterator.next(), signal);
            signal.throwIfAborted();
            active();
            if (chunk.done)
                break;
            size += chunk.value.byteLength;
            if (size > FILE_POLICY.maxBytes)
                throw new AcquisitionError("ARTIFACT.TOO_LARGE");
            chunks.push(Buffer.from(chunk.value));
        }
    }
    catch (error) {
        if (error instanceof AcquisitionError)
            throw error;
        throw new AcquisitionError("SOURCE.NETWORK_UNAVAILABLE");
    }
    finally {
        response.close();
    }
    if (!size || (expected !== null && size !== expected))
        throw new AcquisitionError("ARTIFACT.INTEGRITY");
    return Buffer.concat(chunks, size);
}
/** One invocation / one file. Returns prepared evidence, never claims publication/registration. */
export async function acquireFile(raw: FileAcquireInput, ports: {
    access: SourceAccess;
    dns: DnsResolver;
}, abort: AbortSignal): Promise<AcquiredFile> {
    const input = FileAcquireInputSchema.parse(raw);
    verifyInput(input, FILE_CONFIG_FINGERPRINT);
    const controller = new AbortController(), signal = AbortSignal.any([abort, controller.signal]);
    const timer = setTimeout(() => controller.abort(new AcquisitionError("SOURCE.NETWORK_UNAVAILABLE")), FILE_POLICY.timeoutMs);
    let lease: SourceLease | undefined;
    let failed = false;
    try {
        signal.throwIfAborted();
        const acquiring = ports.access.acquire(input, signal).then(async (value) => {
            if (signal.aborted) {
                await value.release();
                signal.throwIfAborted();
            }
            return value;
        });
        lease = await abortable(acquiring, signal);
        session(lease, input);
        const transport = lease.transport;
        const origins = [...lease.allowedOrigins], initial = permittedUrl(lease.url, origins);
        let url = initial;
        const active = () => { session(lease!, input); if (lease!.transport !== transport)
            throw new AcquisitionError("SOURCE.SESSION_MISMATCH"); };
        for (let redirects = 0;; redirects++) {
            active();
            signal.throwIfAborted();
            const address = await abortable(transportAddress(url, transport, ports.dns, signal), signal);
            active();
            // No cookie, Authorization or Referer propagation across origins, even on an allowed CDN hop.
            const headers = url.origin === initial.origin ? safeHeaders(lease.headersForUrl ? lease.headersForUrl(url.href) : lease.headersFor(url.origin)) : {};
            const pending = transport.get(url, address, headers, signal).catch(error => {
                if (error instanceof AcquisitionError)
                    throw error;
                throw new AcquisitionError("SOURCE.NETWORK_UNAVAILABLE");
            }).then(value => {
                if (signal.aborted) {
                    value.close();
                    signal.throwIfAborted();
                }
                return value;
            });
            const response = await abortable(pending, signal);
            try {
                active();
                signal.throwIfAborted();
                if (redirectStatuses.has(response.status)) {
                    if (redirects >= FILE_POLICY.maxRedirects || !response.headers.location)
                        throw new AcquisitionError("SOURCE.REDIRECT_LIMIT");
                    let next: string;
                    try {
                        next = new URL(response.headers.location, url).href;
                    }
                    catch {
                        throw new AcquisitionError("SOURCE.ORIGIN_BLOCKED");
                    }
                    url = permittedUrl(next, origins);
                    continue;
                }
                if (response.status !== 200)
                    throw new AcquisitionError("SOURCE.HTTP_STATUS");
                const bytes = await readBody(response, signal, active), digest = hash(bytes);
                if (input.expectedSha256 !== null && input.expectedSha256 !== digest)
                    throw new AcquisitionError("ARTIFACT.INTEGRITY");
                const media = inspectMedia(bytes, response.headers["content-type"], FILE_POLICY.maxPixels);
                const file = ArtifactRefSchema.parse({ schemaVersion: 1, artifactId: `file-${hash(input.operationId)}`,
                    observationId: input.observationId, sourceId: input.sourceId, listingId: input.listingId, variantId: input.variantId,
                    kind: media.mediaType === "application/pdf" ? "source-pdf" : "source-image", mediaType: media.mediaType,
                    sha256: digest, byteSize: bytes.length, objectKey: `v3/${input.observationId}/${input.operationId}/source`,
                    producer: { operationId: input.operationId, module: input.module, implementationVersion: input.implementationVersion } });
                active();
                signal.throwIfAborted();
                return { input, file, bytes, dimensions: media.dimensions, redirects, artifactDurable: false, resultRegistered: false };
            }
            finally {
                response.close();
            }
        }
    }
    catch (error) {
        failed = true;
        if (error instanceof AcquisitionError)
            throw error;
        if (signal.aborted)
            throw new AcquisitionError("SOURCE.NETWORK_UNAVAILABLE");
        throw new AcquisitionError("SOURCE.SESSION_UNAVAILABLE");
    }
    finally {
        clearTimeout(timer);
        if (lease) {
            // Releasing the lease only unpins this operation; it must not close the owner's browser.
            try {
                await abortable(lease.release(), AbortSignal.timeout(5000));
            }
            catch {
                if (!failed)
                    throw new AcquisitionError("SOURCE.SESSION_UNAVAILABLE");
            }
        }
    }
}
