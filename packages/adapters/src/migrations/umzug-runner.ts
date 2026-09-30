import { migrationErrors } from "@crawl-automation/app";
import type { Logger } from "@crawl-automation/platform";
import { MigrationError, Umzug } from "umzug";
import {
  MigrationHistoryRepository,
  type MigrationQuery,
} from "../postgres/migration-history-repository.js";
import { migrationBody, type SqlMigration } from "./sql-catalog.js";

/** Programmatic up only. The enclosing repository commits SQL and history as one transaction. */
export async function runPendingMigrations(options: {
  database: MigrationQuery;
  catalog: readonly SqlMigration[];
  logger: Logger;
}): Promise<void> {
  const { database, catalog, logger } = options;
  const storage = new MigrationHistoryRepository(database, catalog);
  // Validate before initialize, even when called without the application's initial check.
  await storage.validate();
  await storage.initialize();
  const runner = new Umzug({
    storage,
    logger,
    migrations: catalog.map((migration) => ({
      name: migration.name,
      up: async () => {
        await database.query(migrationBody(migration));
      },
    })),
  });
  try {
    await runner.up();
  } catch (cause) {
    throw migrationErrors.create("MIGRATION.SQL_FAILED", {
      cause,
      details: cause instanceof MigrationError ? { name: cause.migration.name } : {},
    });
  }
}
