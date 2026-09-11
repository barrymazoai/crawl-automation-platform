import { isDeepStrictEqual } from "node:util";
import { validateHeaderValue } from "node:http";
import { GncCaptureInputSchema, type GncCaptureInput } from "@crawl-automation/v3-contracts";
import { abortable, transportAddress, permittedUrl, systemDns, requireCapability, NetworkError,
  AcquisitionError, type DnsResolver, type HttpRoute, type Response } from "@crawl-automation/v3-acquisition";
import { GNC_POLICY, GncError, type GncPageReader } from "./gnc.js";

/** Private, exact request authorization. Do not put headers or this grant catalog in Temporal history. */
export type GncHttpGrant = { input: GncCaptureInput; expiresAt: string; headers?: Readonly<Record<string, string>> };
export const GNC_HTTP_POLICY = Object.freeze({ timeoutMs: 30000, maxBytes: GNC_POLICY.maxBytes, redirects: 0 });
function safeHeaders(raw: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const result: Record<string, string> = { accept: "text/html" };
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(raw)) {
    const name = key.toLowerCase();
    if (!["cookie", "authorization", "user-agent", "accept", "referer"].includes(name) || seen.has(name) ||
      typeof value !== "string" || value.length > 8192 || /[\r\n\0]/.test(value)) throw new NetworkError("NETWORK.CONFIG_INVALID");
    try { validateHeaderValue(name, value); } catch { throw new NetworkError("NETWORK.CONFIG_INVALID"); }
    seen.add(name); result[name] = value;
  }
  return Object.freeze(result);
}

/** Fixed-route, bounded raw HTTP reader. Does not execute JS, rotate routes or own a browser session.
 * Immutable per-request grants isolate operations; sessionId binds config, not an observed public IP.
 */
export class GncHttpReader implements GncPageReader {
  readonly #grants: readonly { input: GncCaptureInput; expiresAt: number; headers: Readonly<Record<string, string>> }[];
  readonly #transport: HttpRoute["transport"];
  constructor(private readonly route: HttpRoute, grants: readonly GncHttpGrant[], private readonly dns: DnsResolver = systemDns) {
    requireCapability(route, "http");
    if (grants.length > 1000) throw new NetworkError("NETWORK.CONFIG_INVALID");
    const seen = new Set<string>();
    this.#grants = grants.map(raw => {
      const input = GncCaptureInputSchema.parse(raw.input), expiresAt = Date.parse(raw.expiresAt);
      if (!Number.isFinite(expiresAt) || seen.has(input.operationId)) throw new NetworkError("NETWORK.CONFIG_INVALID");
      seen.add(input.operationId);
      if (input.binding.egressId !== route.selection.egressId) throw new NetworkError("NETWORK.ROUTE_MISMATCH");
      return { input, expiresAt, headers: safeHeaders(raw.headers ?? {}) };
    });
    this.#transport = route.transport;
  }
  async read(raw: GncCaptureInput, abort: AbortSignal) {
    const input = GncCaptureInputSchema.parse(raw);
    const grant = this.#grants.find(g => isDeepStrictEqual(g.input, input));
    if (!grant) throw new GncError("GNC.SESSION_CONFLICT");
    const controller = new AbortController(), signal = AbortSignal.any([abort, controller.signal]);
    const timer = setTimeout(() => controller.abort(new NetworkError("NETWORK.TIMEOUT")), GNC_HTTP_POLICY.timeoutMs);
    let response: Response | undefined;
    const active = () => {
      signal.throwIfAborted(); requireCapability(this.route, "http");
      if (this.route.transport !== this.#transport || this.#transport.egressId !== input.binding.egressId) throw new NetworkError("NETWORK.ROUTE_MISMATCH");
      if (Date.now() >= grant.expiresAt) throw new GncError("GNC.SESSION_EXPIRED");
    };
    try {
      active();
      const url = permittedUrl(input.url, ["https://www.gnc.com"]);
      const address = await abortable(transportAddress(url, this.#transport, this.dns, signal), signal);
      active();
      const pending = this.#transport.get(url, address, grant.headers, signal).then(r => {
        if (signal.aborted) { r.close(); signal.throwIfAborted(); } return r;
      });
      response = await abortable(pending, signal); active();
      if (response.status >= 300 && response.status < 400) throw new GncError("GNC.REDIRECT_UNVERIFIED");
      if ([403, 406, 429].includes(response.status)) throw new GncError("GNC.ACCESS_CHALLENGE");
      if ([404, 410].includes(response.status)) throw new GncError("GNC.NOT_FOUND");
      if (response.status !== 200) throw new GncError("GNC.HTTP_STATUS");
      const contentType = response.headers["content-type"] ?? "";
      if (!/^text\/html(?:\s*;|$)/i.test(contentType)) throw new GncError("GNC.NOT_HTML");
      const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
      if (encoding && encoding !== "identity") throw new GncError("GNC.ENCODING");
      const rawLength = response.headers["content-length"];
      if (rawLength !== undefined && !/^\d+$/.test(rawLength)) throw new GncError("GNC.BODY_INTEGRITY");
      const expected = rawLength === undefined ? null : Number(rawLength);
      if (expected !== null && (!Number.isSafeInteger(expected) || expected > GNC_HTTP_POLICY.maxBytes)) throw new GncError("GNC.PAGE_LIMIT");
      let size = 0; const chunks: Buffer[] = [];
      const iterator = response.body[Symbol.asyncIterator]();
      while (true) {
        active(); const chunk = await abortable(iterator.next(), signal); active();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > GNC_HTTP_POLICY.maxBytes) throw new GncError("GNC.PAGE_LIMIT");
        chunks.push(Buffer.from(chunk.value));
      }
      if (!size || (expected !== null && expected !== size)) throw new GncError("GNC.BODY_INTEGRITY");
      return { operationId: input.operationId, requestedUrl: input.url, finalUrl: input.url, binding: input.binding,
        status: response.status, contentType, bytes: Buffer.concat(chunks, size), network: this.route.selection };
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof GncError || error instanceof NetworkError || error instanceof AcquisitionError) throw error;
      throw new AcquisitionError("SOURCE.NETWORK_UNAVAILABLE");
    } finally { clearTimeout(timer); response?.close(); }
  }
}
