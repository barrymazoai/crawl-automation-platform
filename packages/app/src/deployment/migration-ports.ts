import { defineErrors } from "@crawl-automation/platform";

const runtime = (message: string) => ({ category: "RUNTIME" as const, message });

/** Shared registry for the migration service and its adapters. */
export const migrationErrors = defineErrors({
  "MIGRATION.CATALOG_INVALID": runtime("The release migration catalog is invalid."),
  "MIGRATION.HISTORY_INVALID": runtime("Applied migrations are not an unchanged catalog prefix."),
  "MIGRATION.QUARANTINED": runtime("The database has a restore quarantine marker."),
  "MIGRATION.UNVERSIONED": runtime("A non-empty database has no migration history."),
  "MIGRATION.TARGET_INVALID": runtime("An explicit V3 database and credentials are required."),
  "MIGRATION.CONFIRMATION_REQUIRED": runtime("Confirmation must match host:port/database."),
  "MIGRATION.BACKUP_FAILED": runtime("The pre-migration database backup failed."),
  "MIGRATION.DATABASE_FAILED": runtime("The database maintenance operation failed."),
  "MIGRATION.SQL_FAILED": runtime("A pending migration failed; the transaction is rolled back."),
  "MIGRATION.FORWARD_ONLY": runtime("Migration history cannot be removed or repaired."),
  "MIGRATION.RECHECK_FAILED": runtime("The final migration history does not match the release."),
});

export interface MigrationStatus {
  applied: string[];
  pending: string[];
}

/** One exclusive session. All changes commit only after the callback returns successfully. */
export interface MigrationSession {
  validate(): Promise<MigrationStatus>;
  backup(directory: string, applied: number): Promise<string>;
  migrate(): Promise<void>;
}

export interface MigrationRepository {
  /** Read-only, including when no ledger exists. */
  status(): Promise<MigrationStatus>;
  /** Checks the target before opening an exclusive, transactional session. */
  withLock<Result>(
    confirmation: string,
    work: (session: MigrationSession) => Promise<Result>,
  ): Promise<Result>;
}

export interface MigrationRequest {
  confirmation: string;
  backupDirectory: string;
  dryRun?: boolean;
}

export interface MigrationResult {
  before: MigrationStatus;
  after: MigrationStatus;
  backup: string | null;
}
