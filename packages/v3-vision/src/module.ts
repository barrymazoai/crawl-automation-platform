import { randomUUID } from "node:crypto";
import { z } from "zod";
import { VisionInputSchema, type ArtifactRef, type Observation, type VisionInput } from "@crawl-automation/v3-contracts";
import { verifyBytes, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { verifySelection, digest } from "./keywords.js";
import { decodeVisionResult } from "./protocol.js";
import type { VisionProvider } from "./provider.js";

export type VisionOutcome = { status: "candidate" | "partial" | "review"; code: string | null; candidate: ReturnType<typeof decodeVisionResult>["candidate"] | null;
  evidenceKey: string; replayed: boolean; automaticRetry: false; /** Codex's own redacted reason for a failed turn. */ detail?: string };
export interface VisionDependencies {
  provider: VisionProvider;
  store: ObjectStore;
  /** Private node journal: retain completed raw response before remote publication. No automatic cleanup. */
  localEvidence: ObjectStore;
  /** Adapter must verify upstream OCR registration/completion and return its original text; no model calls. */
  verifiedOcrText(selection: VisionInput["selection"], signal: AbortSignal): Promise<string>;
  resolve(image: ArtifactRef, signal: AbortSignal, owner: Observation): Promise<Uint8Array>;
}
const intentSchema = z.strictObject({ fingerprint: z.string(), nonce: z.uuid(), input: VisionInputSchema });
const responseSchema = z.strictObject({ fingerprint: z.string(), raw: z.string().max(250000), sha256: z.string() });
// `detail` is optional so failure evidence written before it existed still replays.
const failureSchema = z.strictObject({ fingerprint: z.string(), code: z.string().regex(/^VISION\.[A-Z_]+$/), executionFact: z.enum(["not_executed", "executed", "unknown"]),
  detail: z.string().max(600).optional() });
/** Durable execution boundary. The result is evidence, not a DB registration or ingestion receipt. */
export class VisionModule {
  constructor(private readonly deps: VisionDependencies) {}
  async run(raw: unknown, signal: AbortSignal): Promise<VisionOutcome> {
    const input = VisionInputSchema.parse(raw);
    const prefix = `v3/vision/${input.operationId}`, evidenceKey = `${prefix}/response.json`;
    const fingerprint = digest(JSON.stringify(["vision-input/1", input, this.deps.provider.fingerprint]));
    const review = (code: string, replayed = false, key = `${prefix}/intent.json`, detail?: string): VisionOutcome =>
      ({ status: "review", code, candidate: null, evidenceKey: key, replayed, automaticRetry: false, ...(detail ? { detail } : {}) });
    const decode = (bytes: Uint8Array, replayed: boolean): VisionOutcome => {
      const stored = responseSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
      if (stored.fingerprint !== fingerprint || digest(stored.raw) !== stored.sha256) throw Error("VISION.EVIDENCE_CONFLICT");
      try { return { ...decodeVisionResult(input, stored.raw), evidenceKey, replayed, automaticRetry: false }; }
      catch { return review("VISION.INVALID_OUTPUT", replayed, evidenceKey); }
    };
    if (input.extractionProtocol !== this.deps.provider.extractionProtocol) return review("VISION.CONFIG_MISMATCH");
    // Revalidate source even on replay. Never trust a forged matched flag.
    verifySelection(input.selection, await this.deps.verifiedOcrText(input.selection, signal));
    signal.throwIfAborted();
    const existing = await this.deps.store.read(`${prefix}/intent.json`, 1024 * 1024, signal);
    if (existing) {
      const prior = intentSchema.parse(JSON.parse(Buffer.from(existing).toString("utf8")));
      if (prior.fingerprint !== fingerprint || JSON.stringify(prior.input) !== JSON.stringify(input)) return review("VISION.INPUT_CONFLICT", true);
      const response = await this.deps.store.read(evidenceKey, 2 * 1024 * 1024, signal);
      if (response) return decode(response, true);
      const local = await this.deps.localEvidence.read(evidenceKey, 2 * 1024 * 1024, signal);
      if (local) return { ...decode(local, true), status: "review", code: "VISION.HANDOFF_PENDING" };
      const failure = await this.deps.localEvidence.read(`${prefix}/failure.json`, 8192, signal);
      if (failure) {
        const f = failureSchema.parse(JSON.parse(Buffer.from(failure).toString()));
        if (f.fingerprint !== fingerprint) return review("VISION.INPUT_CONFLICT", true);
        return review(f.code, true, `${prefix}/failure.json`, f.detail);
      }
      return review("VISION.EXECUTION_UNKNOWN", true);
    }
    const bytes = await this.deps.resolve(input.selection.image, signal, input.selection.observation);
    verifyBytes(input.selection.image, bytes, 16 * 1024 * 1024);
    const intent = { fingerprint, nonce: randomUUID(), input };
    const intentBytes = Buffer.from(JSON.stringify(intent));
    // Atomic create is the only claim. A lost receipt never authorizes another model execution.
    const claim = await this.deps.store.create(`${prefix}/intent.json`, intentBytes, "application/json", signal);
    if (claim !== "created") return review("VISION.EXECUTION_UNKNOWN");
    const readback = await this.deps.store.read(`${prefix}/intent.json`, 1024 * 1024, signal);
    if (!readback || !Buffer.from(readback).equals(intentBytes)) return review("VISION.INTENT_UNVERIFIED");
    let rawResponse: string;
    try { rawResponse = await this.deps.provider.interpret(input.selection.image, bytes, signal); }
    catch (e) {
      const error = z.object({ code: z.string().regex(/^VISION\.[A-Z_]+$/), executionFact: z.enum(["not_executed", "executed", "unknown"]),
        detail: z.string().max(600).optional() }).safeParse(e);
      const failure = { fingerprint, ...(error.success ? error.data : { code: "VISION.EXECUTION_UNKNOWN", executionFact: "unknown" }) };
      // Cancellation does not erase failure evidence; persistence has an independent bounded lifetime.
      await this.deps.localEvidence.create(`${prefix}/failure.json`, Buffer.from(JSON.stringify(failure)), "application/json", AbortSignal.timeout(10000));
      return review(failure.code, false, `${prefix}/failure.json`, "detail" in failure ? failure.detail : undefined);
    }
    if (Buffer.byteLength(rawResponse) > 250000) return review("VISION.OUTPUT_LIMIT");
    const output = Buffer.from(JSON.stringify({ fingerprint, raw: rawResponse, sha256: digest(rawResponse) }));
    const retention = AbortSignal.timeout(10000);
    await this.deps.localEvidence.create(evidenceKey, output, "application/json", retention);
    const local = await this.deps.localEvidence.read(evidenceKey, 2 * 1024 * 1024, retention);
    if (!local || !Buffer.from(local).equals(output)) return review("VISION.LOCAL_EVIDENCE_CONFLICT");
    let retained: Uint8Array | null;
    try {
      await this.deps.store.create(evidenceKey, output, "application/json", signal);
      retained = await this.deps.store.read(evidenceKey, 2 * 1024 * 1024, signal);
    } catch { return { ...decode(local, false), status: "review", code: "VISION.HANDOFF_PENDING" }; }
    if (!retained || !Buffer.from(retained).equals(output)) return review("VISION.HANDOFF_UNVERIFIED", false, evidenceKey);
    return decode(retained, false);
  }
}
