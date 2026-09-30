import {
  migrationErrors,
  type MigrationRepository,
  type MigrationRequest,
  type MigrationResult,
  type MigrationStatus,
} from "./migration-ports.js";

/** Deployment ordering; the repository owns database, backup and migration mechanics. */
export class MigrationService {
  constructor(private readonly repository: MigrationRepository) {}

  status(): Promise<MigrationStatus> {
    return this.repository.status();
  }

  async migrate(request: MigrationRequest): Promise<MigrationResult> {
    if (request.dryRun) {
      const before = await this.status();
      return { before, after: before, backup: null };
    }
    return this.repository.withLock(request.confirmation, async (session) => {
      const before = await session.validate();
      let backup: string | null = null;
      if (before.pending.length) {
        backup = await session.backup(request.backupDirectory, before.applied.length);
        await session.migrate();
      }
      const after = await session.validate();
      const expected = [...before.applied, ...before.pending];
      if (after.pending.length || JSON.stringify(after.applied) !== JSON.stringify(expected)) {
        throw migrationErrors.create("MIGRATION.RECHECK_FAILED");
      }
      return { before, after, backup };
    });
  }
}
