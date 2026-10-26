import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { migrationErrors } from "@crawl-automation/app";
import type { MigrationQuery } from "./migration-history-repository.js";

const execute = promisify(execFile);

/**
 * The 2026-10-22 database dumps 1.4 GB+ and no longer finishes in 90 s (two backups were cut off and migration 065
 * stopped before running). The dump reads one exported snapshot, so a long dump changes nothing; it only has to end.
 */
const DUMP_TIMEOUT_MS = 30 * 60_000;

export interface MigrationConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** A single snapshot dump while the caller holds the migration lock and transaction. */
export class BackupRepository {
  constructor(
    private readonly database: MigrationQuery,
    private readonly connection: MigrationConnection,
    private readonly executable = "pg_dump",
  ) {}

  async backup(parent: string, applied: number): Promise<string> {
    try {
      if (!isAbsolute(parent)) {
        throw migrationErrors.create("MIGRATION.BACKUP_FAILED");
      }
      const directory = await mkdtemp(join(parent, "v3-backup-"));
      await chmod(directory, 0o700);
      const file = join(directory, "database.dump");
      await writeFile(file, "", { mode: 0o600, flag: "wx" });
      await this.dump(file);
      const manifest = {
        format: 1,
        database: this.connection.database,
        createdAt: new Date().toISOString(),
        sha256: await fileDigest(file),
        applied,
        recovery: "quarantine-required",
      };
      await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      return directory;
    } catch (cause) {
      throw migrationErrors.create("MIGRATION.BACKUP_FAILED", { cause });
    }
  }

  private async dump(file: string): Promise<void> {
    const snapshots = await this.database.query<{ id: string }>(
      "SELECT pg_export_snapshot() AS id",
    );
    const snapshot = snapshots[0]?.id;
    if (!snapshot) {
      throw migrationErrors.create("MIGRATION.BACKUP_FAILED");
    }
    await execute(
      this.executable,
      [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--no-password",
        `--snapshot=${snapshot}`,
        `--file=${file}`,
      ],
      { env: this.environment(), timeout: DUMP_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    await chmod(file, 0o600);
  }

  private environment(): NodeJS.ProcessEnv {
    const { host, port, database, user, password } = this.connection;
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("PG")),
    );
    return {
      ...env,
      PGHOST: host,
      PGPORT: String(port),
      PGDATABASE: database,
      PGUSER: user,
      PGPASSWORD: password,
      PGCONNECT_TIMEOUT: "5",
      PGSSLMODE: "disable",
      // pg_dump's COPY of the largest table is one statement; the dump as a whole is bounded by DUMP_TIMEOUT_MS.
      PGOPTIONS: "-c search_path=public -c statement_timeout=0",
    };
  }
}

/** Streamed: the 2026-10-26 dump passed 2 GiB, the most `readFile` returns, and stopped migration 068. */
async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}
