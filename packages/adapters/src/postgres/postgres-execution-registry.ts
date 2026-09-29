import { isDeepStrictEqual } from "node:util";
import { appErrors, type ExecutionRef, type ExecutionRegistry } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";

/** Links an observation to the workflow that collected it (`observation_execution`, append-only). */
export class PostgresExecutionRegistry implements ExecutionRegistry {
  constructor(private readonly database: Queryable) {}

  async register(observationId: string, execution: ExecutionRef): Promise<void> {
    await this.database.query(
      "INSERT INTO observation_execution(observation_id, execution) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [observationId, execution],
    );
    const rows = await this.database.query<{ execution: unknown }>(
      "SELECT execution FROM observation_execution WHERE observation_id = $1",
      [observationId],
    );
    if (!rows.every((row) => isDeepStrictEqual(row.execution, execution))) {
      throw appErrors.create("PIPELINE.EXECUTION_CONFLICT", { details: { observationId } });
    }
  }
}
