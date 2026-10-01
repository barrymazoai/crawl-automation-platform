import { PostgresUsageMeasurements } from "@crawl-automation/adapters";
import type { Database, Logger } from "@crawl-automation/platform";
import { registerActivityMeasurements } from "./activity-context.js";

export function activityContextParts(log: Logger, database: Database): void {
  registerActivityMeasurements(log, new PostgresUsageMeasurements(database));
}
