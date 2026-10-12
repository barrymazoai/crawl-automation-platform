import {
  EnrichmentWorkflowStarter,
  PostgresEnrichmentRepository,
} from "@crawl-automation/adapters";
import { EnrichmentBackfill } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import type { ApiConfig } from "./config.js";

/** Its own inputs, not the container's type, so container.ts can import it without a cycle. */
export const enrichmentService = (parts: {
  database: Database;
  temporal: { client: ConstructorParameters<typeof EnrichmentWorkflowStarter>[0] };
  config: Pick<ApiConfig, "pipeline">;
}) =>
  new EnrichmentBackfill(
    new PostgresEnrichmentRepository(parts.database),
    new EnrichmentWorkflowStarter(parts.temporal.client, parts.config.pipeline.queues.activities),
  );
