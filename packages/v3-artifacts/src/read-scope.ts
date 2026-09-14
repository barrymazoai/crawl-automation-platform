import { AsyncLocalStorage } from "node:async_hooks";
import { ObjectKeySchema } from "@crawl-automation/v3-contracts";
import { ArtifactError, type ObjectStore } from "./ports.js";

type Scope = { values: Map<string, Uint8Array>; bytes: number; reads: number; hits: number; revision: number; active: boolean };
/** Reuse positive immutable GETs only within one Activity. Never retain missing
 * objects, PUT receipts, failures, or another Activity's durability observations. */
export class ActivityObjectReads implements ObjectStore {
  private readonly scopes = new AsyncLocalStorage<Scope>();
  constructor(private readonly remote: ObjectStore, private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxEntries = 512) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1)
      throw new ArtifactError("ARTIFACT.TOO_LARGE");
  }
  async run<T>(fn: () => Promise<T>, report?: (stats: { reads: number; hits: number }) => void): Promise<T> {
    const scope: Scope = { values: new Map(), bytes: 0, reads: 0, hits: 0, revision: 0, active: true };
    return this.scopes.run(scope, async () => {
      try { return await fn(); }
      finally { scope.active = false; scope.values.clear(); scope.bytes = 0; report?.({ reads: scope.reads, hits: scope.hits }); }
    });
  }
  async read(key: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null> {
    ObjectKeySchema.parse(key); signal.throwIfAborted();
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ArtifactError("ARTIFACT.TOO_LARGE");
    const scope = this.scopes.getStore(), revision = scope?.revision, saved = scope?.values.get(key);
    if (saved) {
      if (saved.byteLength > maxBytes) throw new ArtifactError("ARTIFACT.TOO_LARGE");
      scope!.hits++; return Uint8Array.from(saved);
    }
    if (scope) scope.reads++;
    const value = await this.remote.read(key, maxBytes, signal);
    signal.throwIfAborted();
    if (value && value.byteLength > maxBytes) throw new ArtifactError("ARTIFACT.TOO_LARGE");
    // Claims coordinate publication. Always read these from the remote store.
    if (scope?.active && scope.revision === revision && value && !key.startsWith("v3/publication-claims/") && !scope.values.has(key) &&
      scope.values.size < this.maxEntries && scope.bytes + value.byteLength <= this.maxBytes) {
      scope.values.set(key, Uint8Array.from(value)); scope.bytes += value.byteLength;
    }
    return value;
  }
  async create(key: string, bytes: Uint8Array, mediaType: string, signal: AbortSignal) {
    const scope = this.scopes.getStore();
    const forget = () => { if (scope) scope.revision++; const saved = scope?.values.get(key); if (saved) { scope!.bytes -= saved.byteLength; scope!.values.delete(key); } };
    forget();
    // Do not seed a successful PUT. The caller must GET and verify it, including
    // uncertain writes and conflicts, exactly as it did before read reuse.
    try { return await this.remote.create(key, bytes, mediaType, signal); }
    finally { forget(); }
  }
}
