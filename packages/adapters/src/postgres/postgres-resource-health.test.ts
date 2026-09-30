import { execFileSync } from "node:child_process";
import type { Database } from "@crawl-automation/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresResourceHealth } from "./postgres-resource-health.js";

interface TemporaryPostgres {
  database: Database;
  stop(): Promise<void>;
}

const hasPostgres = (() => {
  try {
    execFileSync("initdb", ["--version"], { stdio: "ignore" });
    execFileSync("pg_ctl", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPostgres || process.env.V3_TEST_SKIP_POSTGRES === "1")(
  "resource health leases on isolated PostgreSQL",
  () => {
    let postgres: TemporaryPostgres | undefined;
    let database: Database;
    let repository: PostgresResourceHealth;
    const controller = '["test-host","/test/root"]';
    const ready = {
      resourceId: "cpu",
      controller,
      healthy: true,
      reason: "ready" as const,
      ttlMs: 15_000,
    };

    beforeAll(async () => {
      const { startTemporaryPostgres } = await vi.importActual<{
        startTemporaryPostgres(): Promise<TemporaryPostgres>;
      }>("../../integration/temporary-postgres.js");
      postgres = await startTemporaryPostgres();
      database = postgres.database;
      repository = new PostgresResourceHealth(database);
    }, 120_000);

    afterAll(async () => {
      await postgres?.stop();
    });
    beforeEach(async () => {
      await database.query("DELETE FROM resource_capacity WHERE resource_id = 'cpu'");
      await database.query(
        "INSERT INTO resource_capacity (resource_id, capacity, controller) VALUES ('cpu', 3, $1)",
        [controller],
      );
    });

    async function state() {
      return database.query<{ seconds: string }>(`SELECT capacity, controller, healthy, reason,
        health_until > now() AS future, health_until <= now() AS expired,
        extract(epoch FROM health_until - now()) AS seconds
        FROM resource_capacity WHERE resource_id = 'cpu'`);
    }

    it("marks its row healthy with a future, configured TTL and preserves ownership/capacity", async () => {
      expect(await repository.write(ready)).toBe(1);
      const [row] = await state();
      expect(row).toMatchObject({
        healthy: true,
        future: true,
        expired: false,
        reason: "ready",
        capacity: 3,
        controller,
      });
      expect(Number(row?.["seconds"])).toBeGreaterThan(10);
      expect(Number(row?.["seconds"])).toBeLessThanOrEqual(15);
    });

    it("stop invalidates health immediately with monitor_stopping", async () => {
      await repository.write(ready);
      expect(
        await repository.write({ ...ready, healthy: false, reason: "monitor_stopping", ttlMs: 0 }),
      ).toBe(1);
      expect(await state()).toEqual([
        expect.objectContaining({
          healthy: false,
          expired: true,
          future: false,
          reason: "monitor_stopping",
        }),
      ]);
    });

    it("claims a configured row that has no controller yet (a migration just added it)", async () => {
      await database.query(
        "INSERT INTO resource_capacity (resource_id, capacity) VALUES ('new-lane', 1)",
      );
      expect(await repository.write({ ...ready, resourceId: "new-lane" })).toBe(1);
      const [row] = await database.query<{ controller: string; healthy: boolean }>(
        "SELECT controller, healthy FROM resource_capacity WHERE resource_id = 'new-lane'",
      );
      expect(row).toEqual({ controller, healthy: true });
    });

    it("matches no rows for a different controller or missing resource, without taking over or inserting", async () => {
      const before = await database.query(
        "SELECT * FROM resource_capacity WHERE resource_id = 'cpu'",
      );
      expect(await repository.write({ ...ready, controller: "foreign-controller" })).toBe(0);
      expect(await repository.write({ ...ready, resourceId: "missing-resource" })).toBe(0);
      expect(
        await database.query("SELECT * FROM resource_capacity WHERE resource_id = 'cpu'"),
      ).toEqual(before);
      expect(
        await database.query(
          "SELECT * FROM resource_capacity WHERE resource_id = 'missing-resource'",
        ),
      ).toEqual([]);
    });
  },
);
