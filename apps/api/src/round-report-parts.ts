import { PostgresRoundReader } from "@crawl-automation/adapters";
import { RoundReportService } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";

/** Stateless over the shared database, so the API context builds it from that one part. */
export function roundReportService(parts: { database: Database }): RoundReportService {
  return new RoundReportService(new PostgresRoundReader(parts.database));
}
