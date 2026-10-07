import type { StopVerificationStore } from "@crawl-automation/app";
import type { Database, PermitOwner } from "@crawl-automation/platform";
import { lockPermit } from "./permit-owner.js";
import { PostgresPermitExecutions } from "./postgres-permit-executions.js";

/** A short bounded candidate page; cursor rotation prevents a running/unknown owner starving others. */
export class PostgresStopVerification implements StopVerificationStore {
  constructor(private readonly database: Database) {}

  async candidates(limit: number, after: string): Promise<string[]> {
    const rows = await this.database.query<{ permitId: string }>(
      `SELECT p.permit_id AS "permitId" FROM resource_permit p
       LEFT JOIN resource_permit_stop s USING (permit_id)
       WHERE p.released_at IS NULL AND p.permit_id > $1 AND (s.state = 'CLEANUP_UNVERIFIED'
         -- A permit that never began work (no stop row); the verifier still requires a closed owner and history.
         OR (s.permit_id IS NULL AND p.granted_at < now() - interval '10 minutes'))
       ORDER BY p.permit_id LIMIT $2`,
      [after, limit],
    );
    return rows.map((row) => row.permitId);
  }

  async exclusive<T>(work: () => Promise<T>, key = "resources.verifyStop"): Promise<T | null> {
    // One recovery at a time across API processes. No permit row is locked during provider I/O.
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
        [key],
      );
      return row?.locked ? work() : null;
    });
  }

  async attempted(owner: PermitOwner): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await lockPermit(transaction, owner);
      await transaction.query(
        `UPDATE resource_permit_stop SET checked_at = now(), cleanup_attempts = cleanup_attempts + 1
         WHERE permit_id = $1`,
        [owner.permitId],
      );
    });
  }

  async settleUnstarted(owner: PermitOwner): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      await lockPermit(transaction, owner);
      const rows = await transaction.query(
        `INSERT INTO resource_permit_stop (permit_id, state, activity_ended_at, checked_at, failure)
         SELECT $1, 'stopped', now(), now(), $2::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM resource_permit_execution WHERE permit_id = $1)
         ON CONFLICT (permit_id) DO NOTHING RETURNING permit_id`,
        [owner.permitId, { code: "PERMIT.WORK_NEVER_SCHEDULED" }],
      );
      return rows.length === 1;
    });
  }

  finish(owner: PermitOwner, failure: Record<string, unknown> | null): Promise<void> {
    return new PostgresPermitExecutions(this.database).finish(owner, failure);
  }
}
