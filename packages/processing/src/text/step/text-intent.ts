import { randomUUID } from "node:crypto";
import { TextInputSchema, type TextInput } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/platform";
import { textFailure } from "../errors.js";
import { decodeJson, MAX_RESULT_BYTES, textKeys } from "../results/text-record.js";

/**
 * Claims the right to call the model for this task: a create-once intent in R2. Only the call that created it may run
 * the model; anyone else learns that the model may already have run and stops.
 */
export async function claimTextIntent(
  remote: ObjectStore,
  claim: { input: TextInput; storageId: string; nodeId: string },
  signal: AbortSignal,
): Promise<void> {
  const { input, storageId, nodeId } = claim;
  const nonce = randomUUID();
  const intent = { schemaVersion: 1, input, storageId, nodeId, nonce };
  const key = textKeys.intent(input);
  let created;
  try {
    created = await remote.create(
      key,
      Buffer.from(JSON.stringify(intent)),
      "application/json",
      signal,
    );
  } catch {
    throw textFailure("TEXT.INTENT_UNKNOWN");
  }
  const bytes = await remote.read(key, MAX_RESULT_BYTES, signal);
  const saved = bytes
    ? (decodeJson(bytes) as { storageId?: unknown; input?: unknown; nonce?: unknown })
    : null;
  const sameInput =
    saved && JSON.stringify(TextInputSchema.parse(saved.input)) === JSON.stringify(input);
  if (!saved || saved.storageId !== storageId || !sameInput) {
    throw textFailure("TEXT.INTENT_CONFLICT");
  }
  if (created !== "created" || saved.nonce !== nonce) {
    throw textFailure("TEXT.EXECUTION_UNKNOWN");
  }
}
