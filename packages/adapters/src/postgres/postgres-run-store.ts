import type {
  BrandRun,
  CatalogProgress,
  RunFilter,
  RunStore,
  RunSummary,
  SubmissionReader,
} from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { CollectionSubmission } from "@crawl-automation/v3-contracts";
import { storeErrors } from "../errors.js";
import { acceptBrandRun } from "./run-acceptance.js";
import { catalogProgress, findRun, listRuns } from "./run-queries.js";

/** Runs stored in Postgres: submissions, their source guards, delivery records and catalog tables. */
export class PostgresRunStore implements RunStore, SubmissionReader {
  constructor(private readonly database: Database) {}

  async accept(run: BrandRun): Promise<RunSummary> {
    const runId = await this.database.transaction((tx) => acceptBrandRun(tx, run));
    const summary = await findRun(this.database, runId);
    if (!summary) {
      throw storeErrors.create("STORE.UNEXPECTED_ROW", { details: { runId } });
    }
    return summary;
  }

  list(filter: RunFilter): Promise<RunSummary[]> {
    return listRuns(this.database, filter);
  }

  find(runId: string): Promise<RunSummary | null> {
    return findRun(this.database, runId);
  }

  catalogProgress(runId: string): Promise<CatalogProgress> {
    return catalogProgress(this.database, runId);
  }

  /** The submission as the delivery coordinator starts it. */
  async get(requestId: string): Promise<CollectionSubmission> {
    const rows = await this.database.query<Record<string, unknown>>(
      `SELECT request_id AS "requestId", workflow_id AS "workflowId", snapshot, created_at AS "createdAt"
       FROM collection_submission WHERE request_id = $1`,
      [requestId],
    );
    const row = rows[0];
    if (!row) {
      throw storeErrors.create("STORE.UNEXPECTED_ROW", { details: { requestId } });
    }
    const createdAt =
      row["createdAt"] instanceof Date ? row["createdAt"].toISOString() : row["createdAt"];
    return CollectionSubmission.parse({ ...row, createdAt, state: "PENDING_DELIVERY" });
  }

  /** Releases the given permits and the run's source guard together. */
  settle(runId: string, permitIds: string[]) {
    return this.database.transaction(async (tx) => {
      const permits = await tx.query(
        `UPDATE resource_permit SET released_at = now()
         WHERE permit_id = ANY($1::text[]) AND released_at IS NULL RETURNING permit_id`,
        [permitIds],
      );
      const guard = await tx.query(
        "DELETE FROM source_submission_guard WHERE request_id = $1 RETURNING source_id",
        [runId],
      );
      return { permitsReleased: permits.length, guardReleased: guard.length === 1 };
    });
  }
}
