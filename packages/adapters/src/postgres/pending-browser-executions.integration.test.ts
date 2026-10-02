import { Client } from "pg";
import { expect, it } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import { pendingBrowserExecutions } from "./pending-browser-executions.js";

// Run on a Mini. Only this connection's temporary tables are used; no durable rows are written.
const connectionString = process.env["CRAWL_TEST_DATABASE_URL"];
it.skipIf(!connectionString)(
  "selects ended native and legacy captures while preserving host/space/lifetime boundaries",
  async () => {
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path = pg_temp");
      await client.query(`CREATE TEMP TABLE resource_permit (
      permit_id text, request jsonb, released_at timestamptz, granted_at timestamptz DEFAULT now()
    ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE resource_permit_stop (
      permit_id text, activity_ended_at timestamptz, checked_at timestamptz
    ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE resource_permit_execution (
      permit_id text, identity jsonb, stopped_at timestamptz
    ) ON COMMIT DROP`);
      for (const id of [
        "native",
        "legacy",
        "running",
        "released",
        "foreign-host",
        "foreign-space",
        "unknown",
      ]) {
        const native = id !== "legacy";
        const identity = {
          kind: "browser-round",
          executionId: `round-${id}`,
          taskSpaceId: id === "foreign-space" ? 7 : 6,
          metadata: {
            host: id === "foreign-host" ? "other" : "own",
            protocol:
              id === "unknown"
                ? "unknown/1"
                : native
                  ? "ego-native-capture/1"
                  : "ego-single-page/1",
          },
        };
        await client.query(
          "INSERT INTO resource_permit (permit_id,request,released_at) VALUES ($1,$2,$3)",
          [id, { workflowId: id, runId: "run" }, id === "released" ? new Date() : null],
        );
        await client.query("INSERT INTO resource_permit_stop VALUES ($1,$2,NULL)", [
          id,
          id === "running" ? null : new Date(),
        ]);
        await client.query("INSERT INTO resource_permit_execution VALUES ($1,$2,NULL)", [
          id,
          identity,
        ]);
      }
      const database: Queryable = {
        query: async (sql, values) => (await client.query(sql, values ? [...values] : [])).rows,
      };
      const selected = await pendingBrowserExecutions(database, { host: "own", taskSpaceId: 6 });
      expect(selected.map((entry) => entry.owner.permitId).sort()).toEqual(["legacy", "native"]);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);
