import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { migrationErrors } from "@crawl-automation/app";

export interface SqlMigration {
  readonly name: string;
  readonly bytes: Buffer;
  readonly sql: string;
  readonly sha256: string;
}

export const migrationDigest = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Exactly this release's files, with no fallback to the invoking checkout or generated SQL. */
export async function loadSqlCatalog(directory: string): Promise<SqlMigration[]> {
  if (!isAbsolute(directory)) {
    throw migrationErrors.create("MIGRATION.CATALOG_INVALID");
  }
  try {
    const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    const catalog = await Promise.all(
      names.map(async (name) => {
        const bytes = await readFile(join(directory, name));
        return { name, bytes, sql: bytes.toString("utf8"), sha256: migrationDigest(bytes) };
      }),
    );
    validateSqlCatalog(catalog);
    return catalog;
  } catch (cause) {
    throw migrationErrors.create("MIGRATION.CATALOG_INVALID", { cause });
  }
}

export function validateSqlCatalog(catalog: readonly SqlMigration[]): void {
  if (!catalog.length) {
    throw migrationErrors.create("MIGRATION.CATALOG_INVALID");
  }
  for (const [index, migration] of catalog.entries()) {
    const version = /^(\d{3})_.+\.sql$/.exec(migration.name)?.[1];
    if (Number(version) !== index + 1) {
      throw migrationErrors.create("MIGRATION.CATALOG_INVALID", {
        details: { name: migration.name, expectedVersion: index + 1 },
      });
    }
    migrationBody(migration);
  }
}

/** Hash the original UTF-8 bytes, then strip the same outer BEGIN/COMMIT as the old tool. */
export function migrationBody(migration: SqlMigration): string {
  const { sql, bytes, sha256, name } = migration;
  const validBytes = Buffer.from(sql, "utf8").equals(bytes) && migrationDigest(bytes) === sha256;
  if (!validBytes || !/^[\s\S]*?\bBEGIN;/.test(sql) || !/COMMIT;\s*$/.test(sql)) {
    throw migrationErrors.create("MIGRATION.CATALOG_INVALID", { details: { name } });
  }
  return sql.replace(/\bBEGIN;/, "").replace(/COMMIT;\s*$/, "");
}
