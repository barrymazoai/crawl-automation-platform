import { isDeepStrictEqual } from "node:util";
import { ResourceRequestSchema, ResourceRecoveryProofSchema, type ResourceRequest, type ResourceRecoveryProof } from "@crawl-automation/v3-contracts";
import { sha256, type ObjectStore } from "@crawl-automation/v3-artifacts";

export type RecoverySnapshot = { request: ResourceRequest; released: boolean };
export type RecoveryEvidence = { status: "verified"; proof: ResourceRecoveryProof; historyBytes: Uint8Array } | { status: "quarantined"; code: string };
export interface RecoveryLedger {
  read(permitId: string): Promise<RecoverySnapshot | null>;
  release(request: ResourceRequest): Promise<unknown>;
}
/** Deterministic bytes: concurrent recovery and a lost reply use the same immutable proof key/content. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  const s = JSON.stringify(value); if (s === undefined) throw Error("RESOURCE_RECOVERY.INVALID_JSON"); return s;
}
/** No Workflow start/reset/cancel, provider, browser or force-release port exists here. */
export class ResourceRecovery {
  constructor(private readonly ledger: RecoveryLedger, private readonly inspect: (r: ResourceRequest) => Promise<RecoveryEvidence>, private readonly store: ObjectStore) {}
  async run(permitId: string, apply: boolean, signal: AbortSignal) {
    const response = (status: "already_released" | "quarantined" | "recoverable" | "released", code: string, evidenceKey?: string) => ({ permitId, status, code, ...(evidenceKey ? { evidenceKey } : {}) });
    signal.throwIfAborted();
    const prior = await this.ledger.read(permitId);
    if (!prior) return response("quarantined", "RESOURCE_RECOVERY.PERMIT_NOT_FOUND");
    const request = ResourceRequestSchema.parse(prior.request);
    if (request.permitId !== permitId) throw Error("RESOURCE_RECOVERY.IDENTITY_CONFLICT");
    if (prior.released) return response("already_released", "RESOURCE_RECOVERY.ALREADY_RELEASED");
    let evidence: RecoveryEvidence;
    try { evidence = await this.inspect(request); } catch { return response("quarantined", "RESOURCE_RECOVERY.EVIDENCE_UNAVAILABLE"); }
    signal.throwIfAborted();
    if (evidence.status === "quarantined") return response("quarantined", /^RESOURCE_RECOVERY\.[A-Z_]+$/.test(evidence.code) ? evidence.code : "RESOURCE_RECOVERY.EVIDENCE_UNAVAILABLE");
    const proof = ResourceRecoveryProofSchema.parse(evidence.proof);
    if (!isDeepStrictEqual(request, proof.request)) throw Error("RESOURCE_RECOVERY.IDENTITY_CONFLICT");
    const key = `v3/resource-recovery/${sha256(Buffer.from(proof.namespace))}/${permitId}/release.json`;
    if (!apply) return response("recoverable", "RESOURCE_RECOVERY.VERIFIED", key);
    const bytes = Buffer.from(canonical(proof));
    if (sha256(evidence.historyBytes) !== proof.historySha256 || evidence.historyBytes.length > 16777216) throw Error("RESOURCE_RECOVERY.HISTORY_INVALID");
    const historyKey = key.replace("release.json", `history-${proof.historySha256}.json`);
    let history = await this.store.read(historyKey, 16777216, signal);
    if (!history) {
      try { await this.store.create(historyKey, evidence.historyBytes, "application/json", signal); } catch { /* Read exact retained bytes once. */ }
      history = await this.store.read(historyKey, 16777216, signal);
    }
    if (!history || sha256(history) !== proof.historySha256) return response("quarantined", "RESOURCE_RECOVERY.RETENTION_UNVERIFIED");
    let saved = await this.store.read(key, 1048576, signal);
    if (!saved) {
      try { await this.store.create(key, bytes, "application/json", signal); } catch { /* Unknown PUT reply: one read, never assume success. */ }
      saved = await this.store.read(key, 1048576, signal);
    }
    if (!saved || sha256(saved) !== sha256(bytes)) return response("quarantined", "RESOURCE_RECOVERY.RETENTION_UNVERIFIED");
    signal.throwIfAborted();
    // The ledger's row lock + exact immutable request comparison arbitrates concurrent normal/recovery releases.
    try { await this.ledger.release(request); } catch { /* A committed release may have lost its reply. Read back once. */ }
    const after = await this.ledger.read(permitId);
    if (!after || !isDeepStrictEqual(after.request, request)) throw Error("RESOURCE_RECOVERY.IDENTITY_CONFLICT");
    return after.released ? response("released", "RESOURCE_RECOVERY.RELEASE_VERIFIED", key) : response("quarantined", "RESOURCE_RECOVERY.RELEASE_UNCONFIRMED", key);
  }
}

/** Existing OCR/text/vision adapters supply only evidence inspection and handoff functions, never a provider. */
export async function restoreComputedHandoff(port: {
  reviewed(): Promise<boolean>;
  inspect(): Promise<{ computed: boolean; durable: boolean; registered: boolean }>;
  upload(): Promise<unknown>; register(): Promise<unknown>;
}, apply: boolean) {
  if (await port.reviewed()) return { status: "quarantined", code: "RESOURCE_RECOVERY.REVIEW_PRESERVED" };
  const before = await port.inspect();
  if (before.durable && before.registered) return { status: "registered", code: "RESOURCE_RECOVERY.HANDOFF_VERIFIED" };
  if (!before.computed && !before.durable) return { status: "quarantined", code: "RESOURCE_RECOVERY.NO_COMPUTED_EVIDENCE" };
  if (!apply) return { status: "recoverable", code: "RESOURCE_RECOVERY.HANDOFF_AVAILABLE" };
  if (!before.durable) { try { await port.upload(); } catch { /* Only evidence readback follows an uncertain write. */ } }
  const durable = await port.inspect();
  if (!durable.durable) return { status: "quarantined", code: "RESOURCE_RECOVERY.HANDOFF_UNCONFIRMED" };
  // A Review created concurrently must not be promoted by recovery.
  if (await port.reviewed()) return { status: "quarantined", code: "RESOURCE_RECOVERY.REVIEW_PRESERVED" };
  if (!durable.registered) { try { await port.register(); } catch { /* Verify, do not repeat a registry write. */ } }
  const after = await port.inspect();
  return after.durable && after.registered ? { status: "registered", code: "RESOURCE_RECOVERY.HANDOFF_VERIFIED" }
    : { status: "quarantined", code: "RESOURCE_RECOVERY.HANDOFF_UNCONFIRMED" };
}
