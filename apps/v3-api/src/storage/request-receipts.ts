import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { Mutation } from "../shared/mutation.js";
import { ApiError, databaseError } from "../errors.js";

const Receipt = z.object({
  operation: z.string(), fingerprint: z.string(), result: z.unknown(),
});

// All callers pass schema-parsed inputs with canonical property order.
// This transaction must contain database work only; never call Temporal here.
export async function withRequestReceipt<T>(
  pool: Pool,
  requestId: string,
  operation: string,
  input: unknown,
  schema: z.ZodType<T>,
  run: (client: PoolClient) => Promise<T>,
): Promise<Mutation<T>> {
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const inserted = await client.query(
      "INSERT INTO api_request_receipt(request_id,operation,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING request_id",
      [requestId, operation, fingerprint],
    );
    // Same-key contenders wait for the entire first transaction to commit.
    if (inserted.rowCount === 0) {
      const row = Receipt.parse((await client.query(
        "SELECT operation,fingerprint,result FROM api_request_receipt WHERE request_id=$1 FOR UPDATE", [requestId],
      )).rows[0]);
      if (row.operation !== operation || row.fingerprint !== fingerprint)
        throw new ApiError(409, "REQUEST_ID_CONFLICT", "This request ID was used for different input.");
      if (row.result == null)
        throw new ApiError(409, "RECEIPT_INCOMPLETE", "Request receipt is incomplete; do not submit a new operation.");
      const value = schema.parse(row.result);
      await client.query("COMMIT");
      return { value, replayed: true };
    }
    const value = schema.parse(await run(client));
    await client.query("UPDATE api_request_receipt SET result=$2::jsonb WHERE request_id=$1", [requestId, JSON.stringify(value)]);
    await client.query("COMMIT");
    return { value, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw databaseError(error);
  } finally {
    client.release();
  }
}
