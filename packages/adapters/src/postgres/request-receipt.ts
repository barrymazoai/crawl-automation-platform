import { createHash } from "node:crypto";
import { appErrors } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";
import { storeErrors } from "../errors.js";

const Receipt = z.object({ operation: z.string(), fingerprint: z.string(), result: z.unknown() });

export interface ReceiptKey<Result> {
  requestId: string;
  /** What the request does, e.g. `brand.create` or `source.update:<brandId>:<sourceId>`. */
  operation: string;
  /** The request's input; the same ID with different input is refused. */
  input: unknown;
  parse: (stored: unknown) => Result;
}

/**
 * Runs a change once per request ID, inside the caller's transaction. Repeating the request returns the stored
 * result, so a client may retry safely after a lost response. `api_request_receipt` keeps one row per request ID.
 */
export async function oncePerRequest<Result>(
  tx: Queryable,
  key: ReceiptKey<Result>,
  work: () => Promise<Result>,
): Promise<Result> {
  await tx.query("SET LOCAL lock_timeout = '3s'");
  const fingerprint = createHash("sha256").update(JSON.stringify(key.input)).digest("hex");
  const inserted = await tx.query(
    `INSERT INTO api_request_receipt (request_id, operation, fingerprint) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING request_id`,
    [key.requestId, key.operation, fingerprint],
  );
  if (inserted.length === 0) {
    return storedResult(tx, key, fingerprint);
  }
  const result = await work();
  await tx.query("UPDATE api_request_receipt SET result = $2::jsonb WHERE request_id = $1", [
    key.requestId,
    JSON.stringify(result),
  ]);
  return result;
}

async function storedResult<Result>(
  tx: Queryable,
  key: ReceiptKey<Result>,
  fingerprint: string,
): Promise<Result> {
  const rows = await tx.query(
    "SELECT operation, fingerprint, result FROM api_request_receipt WHERE request_id = $1 FOR UPDATE",
    [key.requestId],
  );
  const receipt = Receipt.parse(rows[0]);
  if (receipt.operation !== key.operation || receipt.fingerprint !== fingerprint) {
    throw appErrors.create("REQUEST.ID_CONFLICT", { details: { requestId: key.requestId } });
  }
  if (receipt.result == null) {
    throw storeErrors.create("STORE.RECEIPT_INCOMPLETE", { details: { requestId: key.requestId } });
  }
  return key.parse(receipt.result);
}
