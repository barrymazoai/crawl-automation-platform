import { validateHeaderValue } from "node:http";
import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import { GncProductInputSchema, FileAcquireInputSchema, observationIdentity, type FileAcquireInput } from "@crawl-automation/v3-contracts";
import { AcquisitionError, NetworkError, permittedUrl, requireCapability, type HttpRoute, type SourceAccess } from "@crawl-automation/v3-acquisition";
import type { GncProductPlans } from "./gnc-product.js";

// Private deployment data, never a Workflow input. Credentials are keyed by exact origin, not all permitted origins.
export const GncFileGrantsSchema = z.array(z.strictObject({ input: GncProductInputSchema,
  allowedOrigins: z.array(z.string().max(2048)).min(1).max(10), expiresAt: z.iso.datetime(),
  headersByOrigin: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  resources: z.array(z.strictObject({ input: FileAcquireInputSchema, url: z.string().max(8192),
    expiresAt: z.iso.datetime(), headers: z.record(z.string(), z.string()) })).max(100).optional(),
})).max(1000).refine(grants => grants.every(g => !(g.resources && g.headersByOrigin)), "Ambiguous credential scope");

function validateHeaders(headers: Record<string, string>) {
  const names = new Set<string>();
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (!["cookie", "authorization", "accept", "user-agent", "referer"].includes(name) || names.has(name) || value.length > 8192 || /[\r\n\0]/.test(value)) throw new NetworkError("NETWORK.CONFIG_INVALID");
    try { validateHeaderValue(name, value); } catch { throw new NetworkError("NETWORK.CONFIG_INVALID"); }
    names.add(name);
  }
}

/** Brand-specific URL resolver over the generic file acquisition port; no browser or capture capability. */
export class GncFileSources implements SourceAccess {
  private readonly grants: z.infer<typeof GncFileGrantsSchema>;
  private readonly transport: HttpRoute["transport"];
  private readonly selection: HttpRoute["selection"];
  constructor(private readonly plans: Pick<GncProductPlans, "fileSource">, private readonly route: HttpRoute, raw: unknown) {
    requireCapability(route, "binary"); this.transport = route.transport; this.selection = structuredClone(route.selection);
    this.grants = GncFileGrantsSchema.parse(raw);
    const seen = new Set<string>();
    for (const g of this.grants) {
      if (!equal(g.input.task.network, this.selection)) throw new NetworkError("NETWORK.ROUTE_MISMATCH");
      // One authorized product plan per observation in a process; avoid ambiguous grants.
      const id = g.input.task.owner.observationId;
      if (seen.has(id)) throw new NetworkError("NETWORK.CONFIG_INVALID"); seen.add(id);
      for (const origin of g.allowedOrigins) if (permittedUrl(origin, [origin]).origin !== origin) throw new NetworkError("NETWORK.CONFIG_INVALID");
      for (const [origin, headers] of Object.entries(g.headersByOrigin ?? {})) {
        if (!g.allowedOrigins.includes(origin)) throw new NetworkError("NETWORK.CONFIG_INVALID");
        validateHeaders(headers);
      }
      const resources = new Set<string>();
      for (const r of g.resources ?? []) {
        if (!equal(observationIdentity(r.input), g.input.task.owner) || !equal(r.input.binding, g.input.task.capture.binding) ||
          resources.has(r.input.resourceId) || Date.parse(r.expiresAt) > Date.parse(g.expiresAt) ||
          permittedUrl(r.url, g.allowedOrigins).href !== r.url) throw new NetworkError("NETWORK.CONFIG_INVALID");
        resources.add(r.input.resourceId); validateHeaders(r.headers);
      }
    }
  }
  async acquire(raw: FileAcquireInput, signal: AbortSignal) {
    const input = FileAcquireInputSchema.parse(raw), owner = observationIdentity(input);
    const g = this.grants.find(g => equal(g.input.task.owner, owner) && equal(g.input.task.capture.binding, input.binding));
    if (!g) throw new AcquisitionError("SOURCE.SESSION_MISMATCH");
    const resource = g.resources?.find(r => equal(r.input, input));
    if (g.resources && !resource) throw new AcquisitionError("SOURCE.SESSION_MISMATCH");
    let released = false;
    const assertActive = () => {
      signal.throwIfAborted();
      if (released || Date.now() >= Date.parse(resource?.expiresAt ?? g.expiresAt)) throw new AcquisitionError("SOURCE.SESSION_UNAVAILABLE");
      requireCapability(this.route, "binary");
      if (this.route.transport !== this.transport || !equal(this.route.selection, this.selection)) throw new NetworkError("NETWORK.ROUTE_MISMATCH");
    };
    assertActive();
    let url: URL;
    try { url = permittedUrl(await this.plans.fileSource(g.input, input, signal), g.allowedOrigins); }
    catch (error) {
      signal.throwIfAborted();
      if (error instanceof AcquisitionError) throw error;
      throw new AcquisitionError("SOURCE.SESSION_MISMATCH");
    }
    assertActive();
    if (resource && resource.url !== url.href) throw new AcquisitionError("SOURCE.SESSION_MISMATCH");
    return { owner, sourceId: owner.sourceId, resourceId: input.resourceId, binding: input.binding,
      url: url.href, allowedOrigins: Object.freeze([...g.allowedOrigins]), transport: this.transport, assertActive,
      headersFor: (origin: string) => { assertActive(); return origin === url.origin ? Object.freeze({ ...g.headersByOrigin?.[origin] }) : {}; },
      ...(resource ? { headersForUrl: (requested: string) => { assertActive(); return requested === url.href ? Object.freeze({ ...resource.headers }) : {}; } } : {}),
      release: async () => { released = true; } };
  }
}
