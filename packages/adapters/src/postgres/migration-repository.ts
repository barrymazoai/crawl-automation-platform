import { isAbsolute } from "node:path";
import {
  migrationErrors,
  type MigrationRepository,
  type MigrationSession,
  type MigrationStatus,
} from "@crawl-automation/app";
import {
  AppError,
  createDatabase,
  type Database,
  type Logger,
  type Queryable,
} from "@crawl-automation/platform";
import { z } from "zod";
import { validateSqlCatalog, type SqlMigration } from "../migrations/sql-catalog.js";
import { runPendingMigrations } from "../migrations/umzug-runner.js";
import { BackupRepository, type MigrationConnection } from "./backup-repository.js";
import { MigrationHistoryRepository } from "./migration-history-repository.js";

const connectionSchema = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  database: z.enum(["crawler_v3_dev", "crawler_v3_test"]),
  user: z.string().min(1),
  password: z.string().min(1),
});

/** Preserve the old tool's explicit local URL policy; sockets are injected by isolated tests. */
export function parseMigrationConnection(value: string): MigrationConnection {
  try {
    const url = new URL(value);
    const localHosts = ["localhost", [127, 0, 0, 1].join(".")];
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !localHosts.includes(url.hostname) ||
      url.search ||
      url.hash
    ) {
      throw migrationErrors.create("MIGRATION.TARGET_INVALID");
    }
    return connectionSchema.parse({
      host: url.hostname,
      port: Number(url.port || "5432"),
      database: url.pathname.slice(1),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
  } catch (cause) {
    throw migrationErrors.create("MIGRATION.TARGET_INVALID", { cause });
  }
}

interface RepositoryOptions {
  connection: MigrationConnection;
  catalog: readonly SqlMigration[];
  logger: Logger;
  pgDump?: string;
}

export class PostgresMigrationRepository implements MigrationRepository {
  private readonly connection: MigrationConnection;

  constructor(private readonly options: RepositoryOptions) {
    const parsed = connectionSchema.safeParse(options.connection);
    if (!parsed.success) {
      throw migrationErrors.create("MIGRATION.TARGET_INVALID", { cause: parsed.error });
    }
    this.connection = parsed.data;
    validateSqlCatalog(options.catalog);
    if (options.pgDump && !isAbsolute(options.pgDump)) {
      throw migrationErrors.create("MIGRATION.BACKUP_FAILED");
    }
  }

  status(): Promise<MigrationStatus> {
    return this.withDatabase((database) =>
      database.transaction(async (transaction) => {
        await transaction.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        return new MigrationHistoryRepository(transaction, this.options.catalog).validate();
      }),
    );
  }

  withLock<Result>(
    confirmation: string,
    work: (session: MigrationSession) => Promise<Result>,
  ): Promise<Result> {
    const { host, port, database } = this.connection;
    if (confirmation !== `${host}:${port}/${database}`) {
      throw migrationErrors.create("MIGRATION.CONFIRMATION_REQUIRED");
    }
    return this.withDatabase((database) =>
      database.transaction(async (transaction) => {
        // READ COMMITTED ensures history is read AFTER a competing migrator commits.
        // The exported dump snapshot is taken before any DDL, while the ledger is locked.
        await transaction.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        await transaction.query("SELECT pg_advisory_xact_lock(73110311)");
        await transaction.query("SET LOCAL search_path=public; SET LOCAL lock_timeout='5s'");
        return work(this.session(transaction));
      }),
    );
  }

  private session(database: Queryable): MigrationSession {
    const { catalog, logger, pgDump } = this.options;
    const history = new MigrationHistoryRepository(database, catalog);
    const backups = new BackupRepository(database, this.connection, pgDump);
    return {
      validate: () => history.validate(),
      backup: (directory, applied) => backups.backup(directory, applied),
      migrate: () => runPendingMigrations({ database, catalog, logger }),
    };
  }

  private async withDatabase<Result>(
    work: (database: Database) => Promise<Result>,
  ): Promise<Result> {
    const database = createDatabase(
      {
        connectionString: migrationConnectionUrl(this.connection),
        maxConnections: 1,
        statementTimeoutMs: 120_000,
      },
      this.options.logger,
    );
    try {
      return await work(database);
    } catch (cause) {
      if (cause instanceof AppError) {
        throw cause;
      }
      throw migrationErrors.create("MIGRATION.DATABASE_FAILED", { cause });
    } finally {
      await database.close();
    }
  }
}

/** Explicit fields also prevent inherited PG* settings from changing the target. */
export function migrationConnectionUrl(connection: MigrationConnection): string {
  const { host, port, database, user, password } = connection;
  const url = new URL("postgresql://localhost");
  url.hostname = isAbsolute(host) ? "localhost" : host;
  url.port = String(port);
  url.pathname = database;
  url.username = encodeURIComponent(user);
  url.password = encodeURIComponent(password);
  if (isAbsolute(host)) {
    url.searchParams.set("host", host);
  }
  url.searchParams.set("sslmode", "disable");
  url.searchParams.set("options", "-c search_path=public");
  return url.href;
}
