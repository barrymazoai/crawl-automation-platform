import { isDeepStrictEqual } from "node:util";
import type { AppError, ObjectStore } from "@crawl-automation/platform";
import { decodeJson, encodeJson } from "../results/result-record.js";

export type IntentFailure = "intentUnknown" | "intentConflict" | "executionUnknown";

interface Intent {
  input: unknown;
  nonce: string;
  storageId?: string;
}

export interface IntentClaim<TIntent extends Intent, TSaved extends Intent = Intent> {
  store: ObjectStore;
  key: string;
  /** The intent this call proposes, with a fresh nonce. */
  intent: TIntent;
  /** A stored intent, checked against its schema. */
  parse(raw: unknown): TSaved;
  limit: number;
  fail(reason: IntentFailure, cause?: unknown): AppError;
  /** Whether a saved intent is for this same task. By default: the same storage and the same input. */
  sameTask?(saved: TSaved, proposed: TIntent): boolean;
}

/**
 * Claims the only right to run the service for a task: a create-once intent in R2. Only the call that created it may
 * run the service; anyone else learns that the service may already have run and stops.
 */
export async function claimIntent<TIntent extends Intent, TSaved extends Intent = Intent>(
  claim: IntentClaim<TIntent, TSaved>,
  signal: AbortSignal,
): Promise<void> {
  const { store, key, intent } = claim;
  let created;
  try {
    created = await store.create(key, encodeJson(intent), "application/json", signal);
  } catch (error) {
    throw claim.fail("intentUnknown", error);
  }
  const bytes = await store.read(key, claim.limit, signal);
  if (!bytes) {
    throw claim.fail("intentUnknown");
  }
  const saved = savedIntent(claim, bytes);
  const sameTask = claim.sameTask ?? sameStorageAndInput;
  if (!sameTask(saved, intent)) {
    throw claim.fail("intentConflict");
  }
  if (created !== "created" || saved.nonce !== intent.nonce) {
    throw claim.fail("executionUnknown");
  }
}

function sameStorageAndInput(saved: Intent, proposed: Intent): boolean {
  return saved.storageId === proposed.storageId && isDeepStrictEqual(saved.input, proposed.input);
}

function savedIntent<TSaved extends Intent>(
  claim: IntentClaim<Intent, TSaved>,
  bytes: Uint8Array,
): TSaved {
  try {
    return claim.parse(decodeJson(bytes));
  } catch (error) {
    throw claim.fail("intentConflict", error);
  }
}
