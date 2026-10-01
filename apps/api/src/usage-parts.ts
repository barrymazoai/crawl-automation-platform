import { PostgresUsageReader } from "@crawl-automation/adapters";
import { UsageService } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";

export function usageService(parts: { database: Database }): UsageService {
  return new UsageService(new PostgresUsageReader(parts.database));
}
