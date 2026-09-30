import { z } from "zod";
import { ObservationSchema, ExecutionIdSchema, SourceBindingSchema, observationIdentity, type FileAcquireInput } from "@crawl-automation/v3-contracts";
import { AcquisitionError, type SourceAccess } from "./ports.js";
import { DirectHttpsTransport, permittedUrl } from "./network.js";
// Private runtime configuration only. Never include this catalog in Workflow inputs or logs.
export const StaticSourceSchema = z.strictObject({ owner: ObservationSchema, resourceId: ExecutionIdSchema,
  binding: SourceBindingSchema.refine(b => b.egressId === "direct/1"), url: z.string().max(8192),
  allowedOrigins: z.array(z.string().max(2048)).min(1).max(10), expiresAt: z.iso.datetime() });
export const StaticSourcesSchema = z.array(StaticSourceSchema).max(1000);
export class StaticDirectSources implements SourceAccess {
  private readonly sources: z.infer<typeof StaticSourcesSchema>;
  constructor(raw: unknown) {
    this.sources = StaticSourcesSchema.parse(raw);
    const seen = new Set<string>();
    for (const s of this.sources) {
      permittedUrl(s.url, s.allowedOrigins);
      for (const origin of s.allowedOrigins) if (permittedUrl(origin, [origin]).origin !== origin) throw Error("Invalid origin");
      const key = JSON.stringify([s.owner, s.resourceId, s.binding]);
      if (seen.has(key)) throw Error("Duplicate static source"); seen.add(key);
    }
  }
  async acquire(input: FileAcquireInput, signal: AbortSignal) {
    signal.throwIfAborted();
    const source = this.sources.find(s => s.resourceId === input.resourceId && JSON.stringify(s.owner) === JSON.stringify(observationIdentity(input)) &&
      JSON.stringify(s.binding) === JSON.stringify(input.binding));
    if (!source) throw new AcquisitionError("SOURCE.SESSION_MISMATCH");
    let released = false;
    const assertActive = () => { if (released || Date.now() >= Date.parse(source.expiresAt)) throw new AcquisitionError("SOURCE.SESSION_UNAVAILABLE"); };
    assertActive();
    return { owner: source.owner, sourceId: source.owner.sourceId, resourceId: source.resourceId, binding: source.binding,
      url: source.url, allowedOrigins: source.allowedOrigins, transport: new DirectHttpsTransport(),
      assertActive, headersFor: (_origin: string) => ({}), release: async () => { released = true; } };
  }
}
