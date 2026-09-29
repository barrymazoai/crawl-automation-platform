import { randomUUID } from "node:crypto";
import { errorCodeOf, type ObjectStore } from "@crawl-automation/platform";
import { sha256 } from "@crawl-automation/v3-artifacts";
import { LabelProductJoinSchema, type LabelProductJoin } from "@crawl-automation/v3-contracts";
import { encodeJson } from "../results/result-record.js";
import { writeOnce } from "../results/write-once.js";
import { assemblyFailure } from "./assembly-errors.js";
import { byText } from "./merge-state.js";

export const ASSEMBLY_LIMIT = 8 * 1024 * 1024;
const INTENT_LIMIT = 65_536;
const KEPT_CODE = /^(LABEL_PRODUCT|LABEL_COLLECTION)\.[A-Z_]+$/;

export const labelAssemblyKey = (input: LabelProductJoin) =>
  `v3/label-products/${input.manifest.operationId}/assembly.json`;

/** The join in a fixed order, so the assembly does not depend on the order sources finished in. */
export function canonicalJoin(raw: unknown): LabelProductJoin {
  const input = LabelProductJoinSchema.parse(raw);
  const byId = (left: { id: string }, right: { id: string }) => byText(left.id, right.id);
  input.manifest.sources.sort(byId);
  input.states.sort(byId);
  input.manifest.admission?.documents.sort((left, right) =>
    byText(left.objectKey, right.objectKey),
  );
  return input;
}

/** The failure's own assembly or collection code; anything else is unresolved evidence. */
export function assemblyCode(error: unknown): string {
  const code = errorCodeOf(error);
  return code && KEPT_CODE.test(code) ? code : "LABEL_PRODUCT.EVIDENCE_UNRESOLVED";
}

/** Keeps a file locally before anything is published; different bytes already kept are a failed handoff. */
export async function keepLocally(
  local: ObjectStore,
  entry: { key: string; bytes: Uint8Array },
  signal: AbortSignal,
): Promise<void> {
  if (entry.bytes.length > ASSEMBLY_LIMIT) {
    throw assemblyFailure("LABEL_PRODUCT.OUTPUT_LIMIT");
  }
  await writeOnce(local, entry, {
    signal,
    mismatch: () => assemblyFailure("LABEL_PRODUCT.HANDOFF_UNVERIFIED"),
  });
}

/** The stored bytes are exactly the expected ones. */
export function assertSameBytes(saved: Uint8Array | null, expected: Uint8Array): void {
  if (!saved || sha256(saved) !== sha256(expected)) {
    throw assemblyFailure("LABEL_PRODUCT.HANDOFF_UNVERIFIED");
  }
}

/** A shared write-ahead claim. An existing or unconfirmed claim is never taken over automatically. */
export async function claimHandoff(
  remote: ObjectStore,
  claim: { key: string; hash: string },
  signal: AbortSignal,
): Promise<void> {
  if (await remote.read(claim.key, INTENT_LIMIT, signal)) {
    throw assemblyFailure("LABEL_PRODUCT.HANDOFF_PENDING");
  }
  const bytes = encodeJson({ hash: claim.hash, nonce: randomUUID() });
  let created;
  try {
    created = await remote.create(claim.key, bytes, "application/json", signal);
  } catch {
    // An unconfirmed claim may exist; it is never taken over.
    throw assemblyFailure("LABEL_PRODUCT.HANDOFF_PENDING");
  }
  if (created !== "created") {
    throw assemblyFailure("LABEL_PRODUCT.HANDOFF_PENDING");
  }
  assertSameBytes(await remote.read(claim.key, INTENT_LIMIT, signal), bytes);
}
