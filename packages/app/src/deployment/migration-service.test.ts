import { describe, expect, it } from "vitest";
import { MigrationService } from "./migration-service.js";
import {
  migrationErrors,
  type MigrationRepository,
  type MigrationSession,
  type MigrationStatus,
} from "./migration-ports.js";

const request = { confirmation: "target", backupDirectory: "/private/backups" };
const before = { applied: ["001.sql"], pending: ["002.sql"] };
const after = { applied: ["001.sql", "002.sql"], pending: [] };

function fixture(failure?: string) {
  const events: string[] = [];
  let state: MigrationStatus = before;
  let validations = 0;
  const record = (event: string) => {
    events.push(event);
    if (event === failure) {
      throw migrationErrors.create("MIGRATION.DATABASE_FAILED", { details: { event } });
    }
  };
  const session: MigrationSession = {
    validate: async () => {
      record(++validations === 1 ? "validate" : "recheck");
      return state;
    },
    backup: async (directory, applied) => {
      expect([directory, applied]).toEqual([request.backupDirectory, before.applied.length]);
      record("backup");
      return "/private/backups/one";
    },
    migrate: async () => {
      record("migrate");
      state = after;
    },
  };
  const repository: MigrationRepository = {
    status: async () => {
      record("status");
      return state;
    },
    withLock: async (confirmation, work) => {
      expect(confirmation).toBe(request.confirmation);
      record("lock");
      try {
        const result = await work(session);
        record("commit");
        return result;
      } catch (cause) {
        record("rollback");
        throw cause;
      } finally {
        record("unlock");
      }
    },
  };
  return {
    service: new MigrationService(repository),
    events,
    session,
    setState: (value: MigrationStatus) => {
      state = value;
    },
  };
}

describe("MigrationService", () => {
  it("validates, backs up once, migrates and rechecks before committing and unlocking", async () => {
    const fake = fixture();
    expect(await fake.service.migrate(request)).toEqual({
      before,
      after,
      backup: "/private/backups/one",
    });
    expect(fake.events).toEqual([
      "lock",
      "validate",
      "backup",
      "migrate",
      "recheck",
      "commit",
      "unlock",
    ]);
  });

  it.each([
    ["validate", ["lock", "validate", "rollback", "unlock"]],
    ["backup", ["lock", "validate", "backup", "rollback", "unlock"]],
    ["migrate", ["lock", "validate", "backup", "migrate", "rollback", "unlock"]],
    ["recheck", ["lock", "validate", "backup", "migrate", "recheck", "rollback", "unlock"]],
  ])("stops on %s failure without proceeding", async (failure, events) => {
    const fake = fixture(failure);
    await expect(fake.service.migrate(request)).rejects.toMatchObject({
      code: "MIGRATION.DATABASE_FAILED",
      details: { event: failure },
    });
    expect(fake.events).toEqual(events);
  });

  it("does not dump or replay an up-to-date database", async () => {
    const fake = fixture();
    fake.setState(after);
    expect(await fake.service.migrate(request)).toEqual({ before: after, after, backup: null });
    expect(fake.events).toEqual(["lock", "validate", "recheck", "commit", "unlock"]);
  });

  it("backs up even an empty first migration target before changing it", async () => {
    const fake = fixture();
    fake.setState({ applied: [], pending: after.applied });
    fake.session.backup = async (_directory, count) => {
      expect(count).toBe(0);
      fake.events.push("backup");
      return "empty-backup";
    };
    expect((await fake.service.migrate(request)).backup).toBe("empty-backup");
  });

  it.each([
    { applied: ["001.sql"], pending: [] },
    { applied: ["001.sql", "002.sql"], pending: ["003.sql"] },
    { applied: ["002.sql", "001.sql"], pending: [] },
  ])("refuses an incorrect final history: %j", async (state) => {
    const fake = fixture();
    fake.session.migrate = async () => {
      fake.setState(state);
    };
    await expect(fake.service.migrate(request)).rejects.toMatchObject({
      code: "MIGRATION.RECHECK_FAILED",
    });
    expect(fake.events).not.toContain("commit");
  });

  it("status calls only the read-only repository operation", async () => {
    const fake = fixture();
    expect(await fake.service.status()).toEqual(before);
    expect(fake.events).toEqual(["status"]);
  });

  it("dry run reads history without locking, dumping or migrating", async () => {
    const fake = fixture();
    expect(await fake.service.migrate({ ...request, dryRun: true })).toEqual({
      before,
      after: before,
      backup: null,
    });
    expect(fake.events).toEqual(["status"]);
  });
});
