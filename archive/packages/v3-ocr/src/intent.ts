import { randomUUID } from "node:crypto";
import { OcrIntentSchema, type OcrInput, type OcrIntent } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { OcrError } from "./ports.js";

/** All nodes must share the same strongly-consistent immutable ObjectStore scope. No lease expiry. */
export class OcrIntents {
  constructor(private readonly store: ObjectStore, private readonly nodeId: string, private readonly storageId: string) {}
  key(input: OcrInput): string { return `ocr-intents/${input.operationId}.json`; }
  async read(input: OcrInput, signal: AbortSignal): Promise<OcrIntent | null> {
    const bytes = await this.store.read(this.key(input), 65536, signal);
    if (!bytes) return null;
    try {
      const record = OcrIntentSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      if (JSON.stringify(record.input) !== JSON.stringify(OcrIntentSchema.shape.input.parse(input)) || record.storageId !== this.storageId)
        throw Error();
      return record;
    } catch { throw new OcrError("OCR.INTENT_CONFLICT"); }
  }
  async acquire(input: OcrInput, signal: AbortSignal): Promise<{ fresh: boolean; intent: OcrIntent }> {
    const proposed = OcrIntentSchema.parse({ schemaVersion: 1, input, nodeId: this.nodeId, storageId: this.storageId,
      nonce: randomUUID(), createdAt: new Date().toISOString() });
    const bytes = Buffer.from(JSON.stringify(proposed));
    if (bytes.length > 65536) throw new OcrError("OCR.INVALID_INPUT", "not_executed");
    // A lost create acknowledgement NEVER grants permission, even if our nonce is subsequently visible.
    let result;
    try { result = await this.store.create(this.key(input), bytes, "application/json", signal); }
    catch { throw new OcrError("OCR.INTENT_UNKNOWN"); }
    const saved = await this.read(input, signal);
    if (!saved) throw new OcrError("OCR.INTENT_UNKNOWN");
    if (result === "created" && saved.nonce !== proposed.nonce) throw new OcrError("OCR.INTENT_CONFLICT", "not_executed");
    return { fresh: result === "created", intent: saved };
  }
}
