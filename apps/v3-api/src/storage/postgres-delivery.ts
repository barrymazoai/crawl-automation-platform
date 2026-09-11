import type { Pool } from "pg";
import { DeliveryReceipt, DeliveryTarget, Id, type DeliveryIssue } from "@crawl-automation/v3-contracts";
import { ApiError, databaseError } from "../errors.js";
import type { DeliveryJournal, ExecutionProof } from "../delivery/port.js";
import { proofIssue, terminalStatuses } from "../delivery/proof-policy.js";

const columns = `request_id AS "requestId",target,input_hash AS "inputHash",run_id AS "runId",
  observed_status AS "observedStatus",last_issue AS "lastIssue",terminal_event_id AS "terminalEventId",
  intent_at AS "intentAt",checked_at AS "checkedAt",closed_at AS "closedAt"`;
function fromRow(row: Record<string, unknown>): DeliveryReceipt {
  const date = (value: unknown) => value instanceof Date ? value.toISOString() : value;
  return DeliveryReceipt.parse({ ...row,
    state: row.closedAt ? "CLOSED" : row.runId ? "CONFIRMED" : "START_UNKNOWN",
    intentAt: date(row.intentAt), checkedAt: date(row.checkedAt), closedAt: date(row.closedAt),
  });
}
export class PostgresDeliveryReader implements Pick<DeliveryJournal, "get"> {
  constructor(private readonly db: Pick<Pool, "query">) {}
  async get(requestId: string) {
    const rows = await this.db.query(`SELECT ${columns} FROM workflow_delivery WHERE request_id=$1`, [Id.parse(requestId)]);
    return rows.rows[0] ? fromRow(rows.rows[0]) : null;
  }
}
export class PostgresDelivery extends PostgresDeliveryReader implements DeliveryJournal {
  constructor(private readonly pool: Pool) { super(pool); }

  async begin(requestId: string, target: DeliveryTarget, hash: string) {
    requestId = Id.parse(requestId);
    target = DeliveryTarget.parse(target);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid input fingerprint");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='3s'");
      const inserted = await client.query(
        `INSERT INTO workflow_delivery(request_id,target,input_hash)
         SELECT r.request_id,$2::jsonb,$3 FROM collection_submission r
         JOIN source_submission_guard g ON g.request_id=r.request_id
         WHERE r.request_id=$1 ON CONFLICT(request_id) DO NOTHING RETURNING request_id`,
        [requestId, JSON.stringify(target), hash],
      );
      const row = (await client.query(`SELECT ${columns} FROM workflow_delivery WHERE request_id=$1 FOR UPDATE`, [requestId])).rows[0];
      if (!row) throw new ApiError(409, "DELIVERY_GUARD_MISSING", "Submission has no source guard; refusing to start.");
      const receipt = fromRow(row);
      if (receipt.inputHash !== hash || JSON.stringify(receipt.target) !== JSON.stringify(target))
        throw new ApiError(409, "DELIVERY_IDENTITY_CONFLICT", "Persisted delivery target/input differs; refusing to redirect this request.");
      await client.query("COMMIT");
      return { mayStart: inserted.rowCount === 1, receipt };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw databaseError(error);
    } finally { client.release(); }
  }

  async record(requestId: string, proof: ExecutionProof | DeliveryIssue) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='3s'");
      const row = (await client.query(`SELECT ${columns} FROM workflow_delivery WHERE request_id=$1 FOR UPDATE`, [Id.parse(requestId)])).rows[0];
      if (!row) throw new ApiError(409, "DELIVERY_INTENT_MISSING", "No delivery intent exists.");
      const current = fromRow(row);
      if (current.state === "CLOSED") {
        await client.query("COMMIT");
        return current; // Stale network callbacks cannot regress terminal proof or release a newer request.
      }
      const issue = proofIssue(current, proof);
      if (issue) {
        await client.query("UPDATE workflow_delivery SET last_issue=$2,checked_at=clock_timestamp() WHERE request_id=$1", [requestId, issue]);
      } else if (typeof proof !== "string") {
        const closed = terminalStatuses.has(proof.status);
        await client.query(
          `UPDATE workflow_delivery SET run_id=$2,observed_status=$3,last_issue=NULL,checked_at=clock_timestamp(),
           closed_at=$4,terminal_event_id=$5 WHERE request_id=$1`,
          [requestId, proof.runId, proof.status, closed ? proof.closedAt : null, closed ? proof.terminalEventId : null],
        );
        if (closed) {
          const released = await client.query("DELETE FROM source_submission_guard WHERE request_id=$1 RETURNING source_id", [requestId]);
          if (released.rowCount !== 1) throw new ApiError(409, "DELIVERY_GUARD_MISSING", "Terminal receipt cannot commit without its source guard.");
        }
      }
      const value = fromRow((await client.query(`SELECT ${columns} FROM workflow_delivery WHERE request_id=$1`, [requestId])).rows[0]);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw databaseError(error);
    } finally { client.release(); }
  }
}
