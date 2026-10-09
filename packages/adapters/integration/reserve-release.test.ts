import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { PostgresResourceAdmission } from "../src/postgres/postgres-resource-admission.js";
import { PostgresPermitExecutions } from "../src/postgres/postgres-permit-executions.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";

let postgres: TemporaryPostgres;
let admission: PostgresResourceAdmission;
const request = {
  permitId: "permit-reserve-failed",
  workflowId: "workflow-one",
  runId: randomUUID(),
  needs: [{ resourceId: "reserve-test-model", units: 1 }],
};
const release = { ...request, reserveFailed: true };

beforeAll(async () => {
  postgres = await startTemporaryPostgres();
  admission = new PostgresResourceAdmission(postgres.database);
}, 120_000);
afterAll(async () => {
  await postgres?.stop();
});
beforeEach(async () => {
  await postgres.database.query(`TRUNCATE resource_permit_execution, resource_permit_stop,
    resource_permit_event, resource_permit_need, resource_permit`);
  await postgres.database.query(
    `INSERT INTO resource_capacity(resource_id, capacity, healthy, health_until)
     VALUES ('reserve-test-model', 1, true, now() + interval '1 hour') ON CONFLICT DO NOTHING`,
  );
});

it("releases a committed reserve with no work, preserves proof and repeats idempotently", async () => {
  await admission.reserve(request);
  await expect(admission.release(request)).rejects.toMatchObject({
    code: "RESOURCE.CLEANUP_UNVERIFIED",
  });
  await expect(admission.release(release)).resolves.toMatchObject({ status: "released" });
  const [first] = await postgres.database.query(
    "SELECT released_at FROM resource_permit WHERE permit_id = $1",
    [request.permitId],
  );
  await expect(admission.release(release)).resolves.toMatchObject({ status: "released" });
  expect(
    await postgres.database.query("SELECT released_at FROM resource_permit WHERE permit_id = $1", [
      request.permitId,
    ]),
  ).toEqual([first]);
  expect(await postgres.database.query("SELECT state, failure FROM resource_permit_stop")).toEqual([
    { state: "stopped", failure: { executionFact: "not_executed", reason: "reserve_failed" } },
  ]);
  await expect(admission.reserve({ ...request, permitId: "next-permit" })).resolves.toMatchObject({
    status: "granted",
  });
  await expect(
    new PostgresPermitExecutions(postgres.database).begin(request),
  ).rejects.toMatchObject({
    code: "RESOURCE.IDENTITY_CONFLICT",
  });
});

it("treats unknown and never-granted waiting permits as no-op releases", async () => {
  await expect(admission.release(release)).resolves.toMatchObject({ status: "released" });
  await admission.reserve({ ...request, permitId: "occupying-permit" });
  await expect(admission.reserve(request)).resolves.toMatchObject({ status: "waiting" });
  await expect(admission.release(release)).resolves.toMatchObject({ status: "released" });
  await expect(admission.release(release)).resolves.toMatchObject({ status: "released" });
  expect(
    await postgres.database.query("SELECT permit_id FROM resource_permit WHERE permit_id = $1", [
      request.permitId,
    ]),
  ).toEqual([]);
});

it("preserves an existing running journal and never releases an execution without proof", async () => {
  await admission.reserve(request);
  await new PostgresPermitExecutions(postgres.database).begin(request);
  await expect(admission.release(release)).rejects.toMatchObject({
    code: "RESOURCE.CLEANUP_UNVERIFIED",
  });
  expect(await postgres.database.query("SELECT state, failure FROM resource_permit_stop")).toEqual([
    { state: "running", failure: null },
  ]);
  expect(await postgres.database.query("SELECT released_at FROM resource_permit")).toEqual([
    { released_at: null },
  ]);
});
