import { pendingBrowserExecutions } from "./pending-browser-executions.js";
import type { PermitActivityLedger } from "@crawl-automation/app";
import type { Database, PermitExecutionIdentity, PermitOwner } from "@crawl-automation/platform";
import { resourceGateErrors } from "@crawl-automation/platform/errors/resource-gate";
import { lockPermit } from "./permit-owner.js";

/** Awaited provider writes: no execution starts before its identity is durable. */
export class PostgresPermitExecutions implements PermitActivityLedger {
  constructor(private readonly database: Database) {}

  pendingBrowser(host: string, taskSpaceId: number) {
    return pendingBrowserExecutions(this.database, { host, taskSpaceId });
  }

  async begin(owner: PermitOwner): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      await lockPermit(tx, owner);
      await tx.query(
        `INSERT INTO resource_permit_stop (permit_id, state) VALUES ($1, 'armed')
         ON CONFLICT DO NOTHING`,
        [owner.permitId],
      );
      const rows = await tx.query(
        `UPDATE resource_permit_stop SET state = 'running'
         WHERE permit_id = $1 AND state = 'armed' RETURNING permit_id`,
        [owner.permitId],
      );
      if (rows.length > 0) {
        return true;
      }
      throw resourceGateErrors.create("RESOURCE.OWNER_QUARANTINED", { details: { owner } });
    });
  }

  async record(owner: PermitOwner, identity: PermitExecutionIdentity): Promise<void> {
    await this.database.transaction(async (tx) => {
      await lockPermit(tx, owner);
      const rows = await tx.query(
        `INSERT INTO resource_permit_execution (permit_id, execution_id, identity)
         SELECT $1, $2, $3 FROM resource_permit_stop
         WHERE permit_id = $1 AND state = 'running' AND activity_ended_at IS NULL
         ON CONFLICT (permit_id, execution_id) DO UPDATE SET identity = EXCLUDED.identity
         WHERE resource_permit_execution.identity = EXCLUDED.identity
           AND resource_permit_execution.stopped_at IS NULL RETURNING execution_id`,
        [owner.permitId, identity.executionId, identity],
      );
      if (rows.length !== 1) {
        throw resourceGateErrors.create("RESOURCE.IDENTITY_CONFLICT", { details: { owner } });
      }
    });
  }

  async prove(
    owner: PermitOwner,
    identity: PermitExecutionIdentity,
    proof: Record<string, unknown>,
  ): Promise<void> {
    await this.database.transaction(async (tx) => {
      await lockPermit(tx, owner);
      const rows = await tx.query(
        `UPDATE resource_permit_execution SET stopped_at = coalesce(stopped_at, now()),
           proof = coalesce(proof, $4) WHERE permit_id = $1 AND execution_id = $2
           AND identity = $3 RETURNING execution_id`,
        [owner.permitId, identity.executionId, identity, proof],
      );
      if (rows.length !== 1) {
        throw resourceGateErrors.create("RESOURCE.IDENTITY_CONFLICT", { details: { owner } });
      }
    });
  }

  async finish(owner: PermitOwner, failure: Record<string, unknown> | null): Promise<void> {
    await this.database.transaction(async (tx) => {
      await lockPermit(tx, owner);
      await tx.query(
        `UPDATE resource_permit_stop SET activity_ended_at = coalesce(activity_ended_at, now()),
         failure = coalesce(failure, $2), state = CASE WHEN EXISTS (
           SELECT 1 FROM resource_permit_execution WHERE permit_id = $1 AND stopped_at IS NULL
         ) THEN 'CLEANUP_UNVERIFIED' ELSE 'stopped' END WHERE permit_id = $1`,
        [owner.permitId, failure],
      );
    });
  }
}
