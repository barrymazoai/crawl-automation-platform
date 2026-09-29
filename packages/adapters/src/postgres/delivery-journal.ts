import {
  proofIssue,
  terminalStatuses,
  type DeliveryIntent,
  type DeliveryJournal,
  type Inspection,
} from "@crawl-automation/app";
import type { Database, Queryable } from "@crawl-automation/platform";
import { DeliveryReceipt, Id, type DeliveryTarget } from "@crawl-automation/v3-contracts";
import { storeErrors } from "../errors.js";

const columns = `request_id AS "requestId", target, input_hash AS "inputHash", run_id AS "runId",
  observed_status AS "observedStatus", last_issue AS "lastIssue", terminal_event_id AS "terminalEventId",
  intent_at AS "intentAt", checked_at AS "checkedAt", closed_at AS "closedAt"`;

type ReceiptRow = Record<string, unknown>;

function toReceipt(row: ReceiptRow): DeliveryReceipt {
  const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
  const state = row["closedAt"] ? "CLOSED" : row["runId"] ? "CONFIRMED" : "START_UNKNOWN";
  return DeliveryReceipt.parse({
    ...row,
    state,
    intentAt: iso(row["intentAt"]),
    checkedAt: iso(row["checkedAt"]),
    closedAt: iso(row["closedAt"]),
  });
}

async function readReceipt(
  db: Queryable,
  requestId: string,
  lock = false,
): Promise<DeliveryReceipt | null> {
  const rows = await db.query<ReceiptRow>(
    `SELECT ${columns} FROM workflow_delivery WHERE request_id = $1 ${lock ? "FOR UPDATE" : ""}`,
    [requestId],
  );
  return rows[0] ? toReceipt(rows[0]) : null;
}

/** `workflow_delivery`: one row per accepted submission; the row's creator alone may start it. */
export class PostgresDeliveryJournal implements DeliveryJournal {
  constructor(private readonly database: Database) {}

  get(requestId: string): Promise<DeliveryReceipt | null> {
    return readReceipt(this.database, Id.parse(requestId));
  }

  begin(requestId: string, target: DeliveryTarget, inputHash: string): Promise<DeliveryIntent> {
    return this.database.transaction(async (tx) => {
      await tx.query("SET LOCAL lock_timeout = '3s'");
      const inserted = await tx.query(
        `INSERT INTO workflow_delivery (request_id, target, input_hash)
         SELECT r.request_id, $2::jsonb, $3 FROM collection_submission r
         JOIN source_submission_guard g ON g.request_id = r.request_id
         WHERE r.request_id = $1 ON CONFLICT (request_id) DO NOTHING RETURNING request_id`,
        [Id.parse(requestId), JSON.stringify(target), inputHash],
      );
      const receipt = await readReceipt(tx, requestId, true);
      if (!receipt) {
        throw storeErrors.create("STORE.DELIVERY_GUARD_MISSING", { details: { requestId } });
      }
      if (
        receipt.inputHash !== inputHash ||
        JSON.stringify(receipt.target) !== JSON.stringify(target)
      ) {
        throw storeErrors.create("STORE.DELIVERY_IDENTITY_CONFLICT", { details: { requestId } });
      }
      return { mayStart: inserted.length === 1, receipt };
    });
  }

  record(requestId: string, inspection: Inspection): Promise<DeliveryReceipt> {
    return this.database.transaction(async (tx) => {
      await tx.query("SET LOCAL lock_timeout = '3s'");
      const current = await readReceipt(tx, Id.parse(requestId), true);
      if (!current) {
        throw storeErrors.create("STORE.DELIVERY_INTENT_MISSING", { details: { requestId } });
      }
      if (current.state !== "CLOSED") {
        await applyInspection(tx, current, inspection);
      }
      return (await readReceipt(tx, requestId)) ?? current;
    });
  }
}

/** Records an issue, or the proof; a proven ending also releases the source guard. */
async function applyInspection(tx: Queryable, current: DeliveryReceipt, inspection: Inspection) {
  const issue = proofIssue(current, inspection);
  if (issue || typeof inspection === "string") {
    await tx.query(
      "UPDATE workflow_delivery SET last_issue = $2, checked_at = clock_timestamp() WHERE request_id = $1",
      [current.requestId, issue ?? inspection],
    );
    return;
  }
  const closed = terminalStatuses.has(inspection.status);
  await tx.query(
    `UPDATE workflow_delivery SET run_id = $2, observed_status = $3, last_issue = NULL,
     checked_at = clock_timestamp(), closed_at = $4, terminal_event_id = $5 WHERE request_id = $1`,
    [
      current.requestId,
      inspection.runId,
      inspection.status,
      closed ? inspection.closedAt : null,
      closed ? inspection.terminalEventId : null,
    ],
  );
  if (closed) {
    await releaseGuard(tx, current.requestId);
  }
}

/** Removes the run's source guard; exactly one must exist. */
export async function releaseGuard(tx: Queryable, requestId: string): Promise<void> {
  const released = await tx.query(
    "DELETE FROM source_submission_guard WHERE request_id = $1 RETURNING source_id",
    [requestId],
  );
  if (released.length !== 1) {
    throw storeErrors.create("STORE.DELIVERY_GUARD_MISSING", { details: { requestId } });
  }
}
