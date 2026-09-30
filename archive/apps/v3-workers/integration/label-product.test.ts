import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { resolve, join } from "node:path";
import pg from "pg";
import { it, expect, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { labelProductFixture } from "../../../packages/v3-product/src/label-product.fixture.js";
import { LabelProductAssembly, CollectLabelProduct, PostgresLabelCollectedProducts, labelCollectedHash } from "@crawl-automation/v3-product";
import { MemoryObjects } from "../../../packages/v3-results/src/testing.fixture.js";
import { gncLabelFixture } from "../../../packages/v3-contracts/src/label.fixture.js";
import { GncLabelInputSchema } from "@crawl-automation/v3-contracts";
const exec = promisify(execFile);
it("real isolated PostgreSQL and Temporal: pending collection frees upstream, /3 snapshot survives cold replay", async () => {
  if (!/^barrydeMac-mini(?:\.|$)/.test(hostname())) throw Error("Run runtime acceptance on Mac mini only");
  const root = await mkdtemp(join(tmpdir(), "label-product-db-")), container = `crawlv3-label-${randomUUID()}`;
  const password = randomUUID(), envPath = join(root, "postgres.env");
  await writeFile(envPath, `POSTGRES_PASSWORD=${password}\nPOSTGRES_DB=crawler_v3_test\n`, { mode: 0o600, flag: "wx" });
  await exec("docker", ["image", "inspect", "postgres:18"], { maxBuffer: 1048576 }); // No implicit image pull.
  let started = false, db: pg.Pool | undefined, temporal: TestWorkflowEnvironment | undefined;
  const workers: Worker[] = [], running: Promise<void>[] = [];
  try {
    await exec("docker", ["run", "--detach", "--name", container, "--env-file", envPath, "--publish", "127.0.0.1::5432", "--memory", "512m", "--cpus", "1", "postgres:18"]); started = true;
    const port = Number((await exec("docker", ["port", container, "5432/tcp"])).stdout.trim().split(":").at(-1));
    db = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", password, database: "crawler_v3_test", connectionTimeoutMillis: 1000 });
    await vi.waitFor(async () => { expect((await db!.query("SELECT current_database() AS name")).rows[0]?.name).toBe("crawler_v3_test"); }, { timeout: 20000, interval: 250 });
    for (const name of ["008_collected_products.sql", "009_mixed_collected_products.sql", "010_label_collected_products.sql"])
      await db.query(await readFile(resolve("sql", name), "utf8"));
    const f = await labelProductFixture([gncLabelFixture()], false), registry = new PostgresLabelCollectedProducts(db);
    temporal = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false, executable: { type: "cached-download", version: "v1.8.3" } } });
    const queues = { vision: "label-vision", text: "unused-text", textReceipts: "unused-receipt", assembly: "label-assembly", collection: "label-collection" };
    const launch = async (taskQueue: string, activities?: Record<string, (...args: any[]) => Promise<unknown>>) => {
      const w = await Worker.create({ connection: temporal!.nativeConnection, taskQueue,
        ...(activities ? { activities, maxConcurrentActivityTaskExecutions: 1 } : { workflowBundle: { codePath: resolve("dist/label/product-workflows.cjs") } }) });
      workers.push(w); const run = w.run(); run.catch(() => {}); running.push(run); return w;
    };
    const signal = () => AbortSignal.timeout(10000), child = f.inputs[0]!;
    const interpretation = await launch(queues.vision, { interpretImage: async task => {
      await child.module.run(task.input, signal()); await child.handoff.complete(task, signal());
      return { status: "registered", operationId: task.input.operationId };
    } });
    await launch("label-workflow");
    const start = () => temporal!.client.workflow.start("LabelProductWorkflow", { workflowId: `label-${randomUUID()}`, taskQueue: "label-workflow",
      args: [{ manifest: f.join.manifest, queues }], workflowExecutionTimeout: "1 minute" });
    const first = await start();
    await vi.waitFor(() => expect(child.records.size).toBe(1), { timeout: 15000 });
    expect(child.provider.interpret).toHaveBeenCalledTimes(1);
    // No assembly/collection worker was running; stop model worker after completed processing.
    interpretation.shutdown();
    await launch(queues.assembly, { assembleLabelProduct: input => f.assembly.run(input, signal()) });
    await vi.waitFor(async () => expect(await f.assembly.inspectReady(f.join, `v3/label-products/${f.join.manifest.operationId}/assembly.json`, signal())).toBeTruthy(), { timeout: 15000 });
    const collector = new CollectLabelProduct({ ...f.deps, assembly: f.assembly, registry });
    await launch(queues.collection, { collectLabelProduct: input => collector.run(input, signal()) });
    const out = await first.result(); expect(out).toMatchObject({ status: "collected" });
    const record = await registry.read(f.join.manifest.operationId); expect(record?.ingredients).toHaveLength(18);
    expect(record?.formula.columns[0]?.rows[14]?.amount?.text).toBe("100 mg");
    const rows = await db.query("SELECT record->>'codec' AS codec,count(*)::int AS n FROM collected_product GROUP BY 1");
    expect(rows.rows).toEqual([{ codec: "collected-product/3", n: 1 }]);
    await expect(db.query("UPDATE collected_product SET record=record")).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("DELETE FROM collected_product")).rejects.toMatchObject({ code: "23514" });
    await Worker.runReplayHistory({ workflowBundle: { codePath: resolve("dist/label/product-workflows.cjs") } }, await first.fetchHistory(), first.workflowId);
    const writes = f.remote.writes;
    const cold = new LabelProductAssembly({ ...f.deps, local: new MemoryObjects() });
    const coldCollector = new CollectLabelProduct({ ...f.deps, local: new MemoryObjects(), assembly: cold, registry });
    expect(await coldCollector.run({ join: f.join, evidenceKey: `v3/label-products/${f.join.manifest.operationId}/assembly.json` }, signal())).toEqual(out);
    expect(f.remote.writes).toBe(writes); expect(child.provider.interpret).toHaveBeenCalledTimes(1);
    expect(labelCollectedHash(record)).toBe((out as { recordHash: string }).recordHash);
    // Verify the new compiled entry separately. Preparation receipt is an explicit test double;
    // real GNC preparation/R2 evidence is verified by the separate Mini acceptance script.
    const owner = f.join.manifest.observation;
    const labelInput = GncLabelInputSchema.parse({ operationId: f.join.manifest.operationId,
      sourcePlan: { operationId: "gnc-source-plan", task: { schemaVersion: 1, implementationVersion: "gnc-acquire/1", owner,
        capture: { kind: "product", requestId: owner.requestId, operationId: "gnc-capture", brandId: owner.brandId, sourceId: owner.sourceId,
          url: "https://www.gnc.com/123456.html", sku: "123456", binding: { sessionId: "fixture", egressId: "direct/1" } },
        network: { routeId: "fixture", version: "1", egressId: "direct/1", mode: "direct", managed: true } },
        text: { schemaVersion: 1, module: "codex.text", implementationVersion: "codex-text/2", policyVersion: "anchored/2", resultSchemaVersion: 2, configFingerprint: "a".repeat(64) },
        ocr: { schemaVersion: 1, module: "ocr.file", implementationVersion: "1", policyVersion: "1", resultSchemaVersion: 2, configFingerprint: "b".repeat(64) }, visionConfigFingerprint: "c".repeat(64) },
      text: { schemaVersion: 1, module: "codex.text", implementationVersion: "codex-text/3", policyVersion: "label-text/1", resultSchemaVersion: 3, configFingerprint: "d".repeat(64) },
      visionConfigFingerprint: child.task.configFingerprint });
    const prepare = vi.fn(async () => ({ status: "prepared", input: labelInput, evidenceKey: `v3/gnc-label-inputs/${labelInput.operationId}/manifest.json`, manifest: f.join.manifest, skipped: [] }));
    await launch("gnc-label-prepare", { prepareGncLabel: prepare });
    await launch(queues.vision, { interpretImage: async task => {
      await child.handoff.readLabelCandidate(task, signal()); return { status: "registered", operationId: task.input.operationId };
    } });
    const routed = await temporal.client.workflow.start("GncPreparedLabelWorkflow", { workflowId: `gnc-label-${randomUUID()}`, taskQueue: "label-workflow",
      args: [{ input: labelInput, queues: { ...queues, prepare: "gnc-label-prepare" } }], workflowExecutionTimeout: "1 minute" });
    expect(await routed.result()).toEqual(out); expect(prepare).toHaveBeenCalledOnce();
    expect(f.remote.writes).toBe(writes); expect(child.provider.interpret).toHaveBeenCalledTimes(1);
    await Worker.runReplayHistory({ workflowBundle: { codePath: resolve("dist/label/product-workflows.cjs") } }, await routed.fetchHistory(), routed.workflowId);
    await writeFile(join(root, "proof.json"), JSON.stringify({ status: "passed", container, collected: 1, codec: record!.codec,
      formulaRows: record!.formula.columns[0]!.rows.length, ingredients: record!.ingredients.length, coldAdditionalPuts: 0, modelCalls: 1,
      model: "synthetic-provider", objectStore: "memory", gncPreparedEntry: "passed-with-preparation-receipt-double", productionDatabase: false }), { flag: "wx", mode: 0o600 });
  } finally {
    for (const w of workers) if (w.getState() === "RUNNING") w.shutdown();
    await Promise.allSettled(running); await temporal?.teardown(); await db?.end();
    if (started) await exec("docker", ["stop", "--time", "10", container]); // Keep evidence/data; do not remove the container/volume.
  }
}, 90000);
