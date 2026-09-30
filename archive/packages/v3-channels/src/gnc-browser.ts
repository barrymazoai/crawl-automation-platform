import { isDeepStrictEqual as equal } from "node:util";
import { GncCaptureInputSchema, NetworkRouteSchema, type GncCaptureInput, type NetworkRoute } from "@crawl-automation/v3-contracts";
import { abortable, type RenderedBrowser } from "@crawl-automation/v3-acquisition";
import { GncError, type GncPageReader } from "./gnc.js";

export type GncBrowserGrant = { input: GncCaptureInput; expiresAt: string };
/** Browser-only GNC entry. It cannot fall back to HTTP or import another process's cookies. */
export class GncBrowserReader implements GncPageReader {
  private readonly network: NetworkRoute;
  private readonly grants: GncBrowserGrant[];
  constructor(network: NetworkRoute, private readonly browser: RenderedBrowser, grants: readonly GncBrowserGrant[]) {
    this.network = NetworkRouteSchema.parse(network);
    if (this.network.egressId !== browser.egressId || grants.length > 1000) throw new GncError("GNC.SESSION_CONFLICT");
    const seen = new Set<string>();
    this.grants = grants.map(g => {
      const input = GncCaptureInputSchema.parse(g.input);
      if (seen.has(input.operationId) || !Number.isFinite(Date.parse(g.expiresAt)) || input.binding.sessionId !== browser.sessionId || input.binding.egressId !== browser.egressId)
        throw new GncError("GNC.SESSION_CONFLICT");
      seen.add(input.operationId); return { input, expiresAt: g.expiresAt };
    });
  }
  async read(raw: GncCaptureInput, signal: AbortSignal) {
    const input = GncCaptureInputSchema.parse(raw), grant = this.grants.find(g => equal(g.input, input));
    if (!grant) throw new GncError("GNC.SESSION_CONFLICT");
    const active = () => {
      signal.throwIfAborted();
      if (Date.now() >= Date.parse(grant.expiresAt)) throw new GncError("GNC.SESSION_EXPIRED");
      if (this.browser.sessionId !== input.binding.sessionId || this.browser.egressId !== input.binding.egressId) throw new GncError("GNC.SESSION_CONFLICT");
    };
    active();
    const page = await abortable(this.browser.read(input.url, signal), signal); active();
    return { operationId: input.operationId, requestedUrl: input.url, finalUrl: page.url, binding: input.binding,
      status: page.status, contentType: page.contentType, bytes: Buffer.from(page.html), network: this.network };
  }
}
