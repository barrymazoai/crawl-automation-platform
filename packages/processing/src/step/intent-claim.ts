import { isDeepStrictEqual } from "node:util";
import type { AppError, ObjectStore } from "@crawl-automation/platform";
import { decodeJson, encodeJson } from "../results/result-record.js";

export type IntentFailure = "intentUnknown" | "intentConflict" | "executionUnknown";

interface Intent {
  input: unknown;
  storageId: string;
  nonce: string;
}

export interface IntentClaim<TIntent extends Intent> {
  store: ObjectStore;
  key: string;
  /** The intent this call proposes, with a fresh nonce. */
  intent: TIntent;
  /** A stored intent, checked against its schema. */
  parse(raw: unknown): Intent;
  limit: number;
  fail(reason: IntentFailure): AppError;
}

/**
 * Claims the only right to run the service for a task: a create-once intent in R2. Only the call that created it may
 * run the service; anyone else learns that the service may already have run and stops.
 */
export async function claimIntent<TIntent extends Intent>(
  claim: IntentClaim<TIntent>,
  signal: AbortSignal,
): Promise<void> {
  const { store, key, intent } = claim;
  let created;
  try {
    created = await store.create(key, encodeJson(intent), "application/json", signal);
  } catch {
    throw claim.fail("intentUnknown");
  }
  const bytes = await store.read(key, claim.limit, signal);
  if (!bytes) {
    throw claim.fail("intentUnknown");
  }
  const saved = savedIntent(claim, bytes);
  if (saved.storageId !== intent.storageId || !isDeepStrictEqual(saved.input, intent.input)) {
    throw claim.fail("intentConflict");
  }
  if (created !== "created" || saved.nonce !== intent.nonce) {
    throw claim.fail("executionUnknown");
  }
}

function savedIntent(claim: IntentClaim<Intent>, bytes: Uint8Array): Intent {
  try {
    return claim.parse(decodeJson(bytes));
  } catch {
    throw claim.fail("intentConflict");
  }
}
