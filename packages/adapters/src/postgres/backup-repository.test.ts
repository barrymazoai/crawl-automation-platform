import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrationDigest } from "../migrations/sql-catalog.js";
import { BackupRepository } from "./backup-repository.js";

const native = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: native }),
}));

const connection = {
  host: "localhost",
  port: 5432,
  database: "crawler_v3_test",
  user: "maintenance",
  password: "private-canary",
};

describe("pre-migration backup", () => {
  beforeEach(() => {
    native.mockReset();
  });

  it("exports one snapshot, dumps once with private files, then writes the legacy manifest", async () => {
    const parent = await mkdtemp(join(tmpdir(), "migration-backup-"));
    const query = vi.fn().mockResolvedValue([{ id: "snapshot-id" }]);
    native.mockImplementation(async (_executable, args: string[], options) => {
      const file = args.find((arg) => arg.startsWith("--file="))?.slice(7);
      if (!file) {
        throw new Error("dump file missing in test");
      }
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(args).toContain("--snapshot=snapshot-id");
      expect(args.join(" ")).not.toContain(connection.password);
      expect(options.env.PGPASSWORD).toBe(connection.password);
      expect(options.env.PGHOST).toBe(connection.host);
      expect(options.env.PGSERVICE).toBeUndefined();
      await writeFile(file, "synthetic custom dump");
    });
    vi.stubEnv("PGSERVICE", "wrong-target");
    try {
      const directory = await new BackupRepository({ query }, connection).backup(parent, 31);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      const manifestFile = join(directory, "manifest.json");
      expect((await stat(manifestFile)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(manifestFile, "utf8"))).toMatchObject({
        format: 1,
        database: connection.database,
        applied: 31,
        recovery: "quarantine-required",
        sha256: migrationDigest("synthetic custom dump"),
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(query).toHaveBeenCalledExactlyOnceWith("SELECT pg_export_snapshot() AS id");
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("retains the real dump error and never publishes a manifest on failure", async () => {
    const parent = await mkdtemp(join(tmpdir(), "migration-backup-"));
    const cause = Object.assign(new Error("dump failed"), { code: "ENOENT" });
    native.mockRejectedValue(cause);
    const query = vi.fn().mockResolvedValue([{ id: "snapshot-id" }]);
    await expect(
      new BackupRepository({ query }, connection).backup(parent, 2),
    ).rejects.toMatchObject({ code: "MIGRATION.BACKUP_FAILED", cause });
    const directories = await readdir(parent);
    expect(directories).toHaveLength(1);
    expect(await readdir(join(parent, directories[0] ?? "missing"))).toEqual(["database.dump"]);
    expect(native).toHaveBeenCalledTimes(1);
  });

  it.each(["relative", "/not-an-existing-backup-parent"])(
    "refuses an unusable backup parent before pg_dump: %s",
    async (parent) => {
      const query = vi.fn();
      await expect(
        new BackupRepository({ query }, connection).backup(parent, 2),
      ).rejects.toMatchObject({ code: "MIGRATION.BACKUP_FAILED" });
      expect(native).not.toHaveBeenCalled();
    },
  );
});
