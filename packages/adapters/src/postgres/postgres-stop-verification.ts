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
       JOIN resource_permit_stop s USING (permit_id)
       WHERE p.released_at IS NULL AND s.state = 'CLEANUP_UNVERIFIED' AND p.permit_id > $1
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

  finish(owner: PermitOwner, failure: Record<string, unknown> | null): Promise<void> {
    return new PostgresPermitExecutions(this.database).finish(owner, failure);
  }
}
