import { hostname, tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ResourceRecovery } from "../../../packages/v3-product/src/resource-recovery.js";
import { PostgresResourceAdmission } from "../../../packages/v3-product/src/resource-admission.js";
import { TemporalResourceEvidence } from "../src/temporal-resource-evidence.js";
import { setup, MemoryObjects, signal } from "../../../packages/v3-results/src/testing.fixture.js";
import { migrationNames, migrate } from "../../v3-api/src/bootstrap/schema.js";

it("Mini: real Temporal history replay + isolated Postgres; lost release, restart, concurrent repair, unknown execution quarantine", async () => {
  if (!/^barrydeMac-mini(?:\.|$)/.test(hostname())) throw Error("Runtime acceptance must run on Mac mini");
  const root = await mkdtemp("/Users/barry/apps/crawlv3-recovery-proof."), dist = dirname(fileURLToPath(import.meta.url));
  const container = `crawlv3-recovery-${randomUUID().slice(0, 8)}`, exec = promisify(execFile), password = randomUUID();
  let owned = false, db: pg.Pool | undefined, temporal: TestWorkflowEnvironment | undefined;
  const workers: Worker[] = [], runs: Promise<void>[] = []; let unblock!: () => void;
  try {
    await writeFile(join(root, "postgres.env"), `POSTGRES_USER=v3_admin\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=crawler_v3_test\n`, { mode: 0o600 });
    await mkdir(join(root, "data"));
    await exec("/opt/homebrew/bin/docker", ["run", "-d", "--name", container, "--label", "crawlv3.recovery-proof=true", "--publish", "127.0.0.1::5432", "--env-file", join(root, "postgres.env"), "--mount", `type=bind,src=${join(root, "data")},dst=/var/lib/postgresql`, "postgres:18"], { timeout: 30000 }); owned = true;
    const port = Number((await exec("/opt/homebrew/bin/docker", ["port", container, "5432/tcp"])).stdout.trim().split(":").at(-1));
    db = new pg.Pool({ connectionString: `postgresql://v3_admin:${password}@127.0.0.1:${port}/crawler_v3_test`, max: 8, connectionTimeoutMillis: 2000, statement_timeout: 10000 });
    await vi.waitFor(async () => { await db!.query("SELECT 1"); }, { timeout: 30000 });
    const migrations = await Promise.all(migrationNames.map(async name => { const sql = await readFile(join(dist, "migrations", name), "utf8"); return { name, sql, sha256: createHash("sha256").update(sql).digest("hex") }; }));
    const c = await db.connect(); try { await migrate(c, migrations); } finally { c.release(); }
    await db.query("INSERT INTO resource_capacity(resource_id,capacity,healthy,health_until) VALUES('test-cpu',1,true,now()+interval '1 hour')");
    const ledger = new PostgresResourceAdmission(db), f = await setup(), store = new MemoryObjects(); let providerCalls = 0;
    const pending = new Promise<void>(r => { unblock = r; }); let slow = false, review = false;
    temporal = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false, executable: { type: "cached-download", version: "v1.8.3" } } });
    const queue = `recovery-${randomUUID()}`, bundlePath = join(dist, "recovery-workflows.cjs");
    const worker = await Worker.create({ connection: temporal.nativeConnection, taskQueue: queue, workflowBundle: { codePath: bundlePath }, activities: {
      reserveResources: (raw: unknown) => ledger.reserve(raw),
      releaseResources: async () => { throw ApplicationFailure.nonRetryable("Injected release transport failure", "TEST.RELEASE_UNAVAILABLE"); },
      ocrFile: async () => { providerCalls++; if (review) return { status: "review", code: "OCR.EXECUTION_UNKNOWN" }; if (slow) { await pending; return {}; }
        await f.handoff.capture(f.input, f.output, signal()); await f.handoff.uploadMissing(f.input, signal());
        const facts = await f.handoff.register(f.input, signal());
        return { status: "registered", operationId: f.input.operationId, resultRegistered: true, result: facts.record!.result, completion: facts.record!.completion };
      },
    } }); workers.push(worker); const running = worker.run(); running.catch(() => {}); runs.push(running);
    const start = () => temporal!.client.workflow.start("ResourceRecoveryFixture", { workflowId: `recovery-${randomUUID()}`, taskQueue: queue, args: [f.input, queue], workflowExecutionTimeout: "2 minutes" });
    const h = await start(); await expect(h.result()).rejects.toThrow();
    const permit = (await db.query("SELECT permit_id FROM resource_permit WHERE released_at IS NULL")).rows[0].permit_id;
    const inspector = new TemporalResourceEvidence({ client: temporal.client, namespace: "default", bundlePath, bundleSha256: createHash("sha256").update(await readFile(bundlePath)).digest("hex"), store: f.remote,
      trustedTypes: ["ResourceRecoveryFixture"], verifyEffect: async effect => { expect(effect.activityType).toBe("ocrFile"); expect(effect.input).toEqual(f.input);
        const facts = await f.handoff.inspect(f.input, signal()); expect(facts.resultRegistered && facts.artifactDurable).toBe(true);
        expect(effect.output).toMatchObject({ result: facts.record!.result, completion: facts.record!.completion }); } });
    const evidence = await inspector.inspect((await ledger.read(permit))!.request); expect(evidence.status).toBe("verified");
    const recovery = new ResourceRecovery(ledger, r => inspector.inspect(r), store);
    expect((await recovery.run(permit, false, signal())).status).toBe("recoverable"); expect(store.writes).toBe(0); expect((await ledger.read(permit))!.released).toBe(false);
    // Fresh recovery object simulates operator/process restart. SQL commits, then its reply is lost.
    const lostReplyLedger = { read: (id: string) => ledger.read(id), release: async (r: any) => { await ledger.release(r); throw Error("lost committed reply"); } };
    store.unknown = true;
    const results = await Promise.all(Array.from({ length: 3 }, () => new ResourceRecovery(lostReplyLedger, async () => evidence, store).run(permit, true, signal())));
    expect(results.every(r => r.status === "released" || r.status === "already_released")).toBe(true);
    expect((await ledger.read(permit))!.released).toBe(true); expect(providerCalls).toBe(1); expect(store.data.size).toBe(2);
    expect((await recovery.run(permit, true, signal())).status).toBe("already_released"); expect(providerCalls).toBe(1);
    slow = true; const blocked = await start(); await vi.waitFor(() => expect(providerCalls).toBe(2), { timeout: 20000 });
    const held = (await db.query("SELECT permit_id FROM resource_permit WHERE released_at IS NULL")).rows[0].permit_id;
    expect((await recovery.run(held, true, signal())).code).toBe("RESOURCE_RECOVERY.OWNER_RUNNING");
    await blocked.terminate("Test external work is still blocked"); await expect(blocked.result()).rejects.toThrow();
    expect((await recovery.run(held, true, signal())).code).toBe("RESOURCE_RECOVERY.NO_UNIQUE_RELEASE_INTENT");
    expect((await ledger.read(held))!.released).toBe(false); expect(providerCalls).toBe(2);
    // A completed Review is not execution-stop proof either. Use a second synthetic capacity slot.
    await db.query("UPDATE resource_capacity SET capacity=2 WHERE resource_id='test-cpu'"); review = true;
    const reviewed = await start(); expect(await reviewed.result()).toMatchObject({ status: "review" });
    const reviewPermit = (await db.query("SELECT permit_id FROM resource_permit WHERE request->>'workflowId'=$1", [reviewed.workflowId])).rows[0].permit_id;
    expect((await ledger.read(reviewPermit))!.released).toBe(false);
    expect((await recovery.run(reviewPermit, true, signal())).code).toBe("RESOURCE_RECOVERY.NO_UNIQUE_RELEASE_INTENT");
    await Worker.runReplayHistory({ workflowBundle: { codePath: bundlePath } }, await reviewed.fetchHistory(), reviewed.workflowId);
    await writeFile(join(root, "report.json"), JSON.stringify({ passed: true, migrations: migrations.length, providerCalls, realProviderCalls: 0, repairedPermits: 1, quarantinedPermits: 2, businessDatabaseWrites: 0, container }, null, 2));
    console.log(JSON.stringify({ evidenceRoot: root, container, realProviderCalls: 0, repairedPermits: 1, quarantinedPermits: 2 }));
  } finally {
    unblock?.(); for (const w of workers) if (w.getState() === "RUNNING") w.shutdown(); await Promise.allSettled(runs);
    await temporal?.teardown(); await db?.end(); if (owned) await exec("/opt/homebrew/bin/docker", ["stop", container], { timeout: 30000 });
  }
}, 180000);
