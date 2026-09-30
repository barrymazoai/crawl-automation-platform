import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadSqlCatalog, migrationBody, validateSqlCatalog } from "./sql-catalog.js";
import { parseMigrationConnection } from "../postgres/migration-repository.js";

const release = fileURLToPath(new URL("../../../../database/v3/", import.meta.url));

describe("release SQL catalog", () => {
  it("preserves all 001–031 names and bytes, and hashes exactly like the old UTF-8 tool", async () => {
    const catalog = await loadSqlCatalog(release);
    expect(catalog).toHaveLength(31);
    expect(catalog.at(-1)?.name).toBe("031_history_grants.sql");
    for (const migration of catalog) {
      const sql = await readFile(join(release, migration.name), "utf8");
      expect(migration.sha256).toBe(createHash("sha256").update(sql).digest("hex"));
      expect(migration.bytes).toEqual(Buffer.from(sql));
      expect(migrationBody(migration)).toBe(sql.replace(/\bBEGIN;/, "").replace(/COMMIT;\s*$/, ""));
    }
  });

  it.each([
    { names: [] },
    { names: ["002_gap.sql"] },
    { names: ["001_first.sql", "001_duplicate.sql"] },
    { names: ["not_versioned.sql"] },
  ])("rejects empty, missing and duplicate versions: %j", async ({ names }) => {
    const directory = await mkdtemp(join(tmpdir(), "migration-catalog-"));
    for (const name of names) {
      await writeFile(join(directory, name), "BEGIN; SELECT 1; COMMIT;");
    }
    await expect(loadSqlCatalog(directory)).rejects.toMatchObject({
      code: "MIGRATION.CATALOG_INVALID",
    });
  });

  it("loads the specified release, preserving line endings and the original name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "migration-catalog-"));
    const sql = "-- é \r\nBEGIN;\r\nSELECT 1;\r\nCOMMIT;\r\n";
    await writeFile(join(directory, "001_custom.sql"), sql);
    expect(await loadSqlCatalog(directory)).toMatchObject([{ name: "001_custom.sql", sql }]);
  });

  it("rejects reversed catalogs, altered bytes, and missing transaction wrappers", async () => {
    const catalog = await loadSqlCatalog(release);
    expect(() => validateSqlCatalog([...catalog].reverse())).toThrow();
    const original = catalog[0];
    expect(original).toBeDefined();
    if (!original) {
      throw new Error("catalog fixture missing");
    }
    for (const changes of [{ sql: "SELECT 1" }, { sha256: "0".repeat(64) }]) {
      expect(() => validateSqlCatalog([{ ...original, ...changes }])).toThrow();
    }
  });
});

describe("migration target", () => {
  it("accepts explicit credentials and returns the exact confirmation target fields", () => {
    expect(
      parseMigrationConnection("postgres://operator:p%40ss@localhost:55432/crawler_v3_dev"),
    ).toEqual({
      host: "localhost",
      port: 55432,
      database: "crawler_v3_dev",
      user: "operator",
      password: "p@ss",
    });
  });

  it.each([
    "",
    "postgres://localhost/crawler_v3_dev",
    "postgres://user:password@localhost/temporal",
    "postgres://user:password@remote.example/crawler_v3_test",
    "postgres://user:password@localhost/crawler_v3_test?host=other",
    "postgres://user:password@localhost/crawler_v3_test#target",
  ])("rejects invalid, unconfirmed or overridden targets: %s", (value) => {
    expect(() => parseMigrationConnection(value)).toThrow(
      expect.objectContaining({ code: "MIGRATION.TARGET_INVALID" }),
    );
  });
});
