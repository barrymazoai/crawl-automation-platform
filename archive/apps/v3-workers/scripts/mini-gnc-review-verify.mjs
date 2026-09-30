// Read-only verification of a terminal access-challenge run. No retry or provider calls.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { parseEnv, promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const [root] = process.argv.slice(2);
assert.equal(process.argv.slice(2).length, 1);
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.match(root ?? "", /^\/Users\/barry\/apps\/crawlv3-gnc-pool\.[A-Za-z0-9]+\/live$/);
const json = async name => JSON.parse(await readFile(join(root, name), "utf8"));
const report = await json("report.json"), workflow = await json("workflow-input.json");
const database = await json("database-evidence.json"), history = await json("history.json");
const task = workflow.input.sourcePlan.task;
assert.equal(report.status, "finished");
assert.equal(report.outcome.status, "review");
assert.equal(report.outcome.code, "GNC.ACCESS_CHALLENGE");
assert.equal(report.outcome.operationId, task.capture.operationId);
assert.equal(report.submittedWorkflows, 1);
assert.equal(database.reviews.length, 1);
assert.equal(database.results.length, 0);
assert.equal(database.products.length, 0);
assert.equal(report.laneReleased, true);
assert.equal(report.laneProcessesStopped, true);
assert.equal(report.databaseStoppedRetained, true);
assert.ok(!report.laneCleanupRequiresInspection);
const stages = history.events.filter(e => e.activityTaskScheduledEventAttributes).map(e => e.activityTaskScheduledEventAttributes);
assert.deepEqual(stages.map(s => s.activityType.name), ["captureGncProduct", "resolveGncReceipt"]);
assert.ok(stages.every(s => s.retryPolicy.maximumAttempts === 1));
assert.ok(report.workers.every(w => { try { process.kill(w.pid, 0); return false; } catch (e) { if (e.code === "ESRCH") return true; throw e; } }));
try { process.kill(report.lane.browserPid, 0); assert.fail("OWNED_BROWSER_STILL_ALIVE"); }
catch (e) { if (e.code !== "ESRCH") throw e; }
assert.match(report.container, /^crawlv3-gnc-[a-f0-9]{8}$/);
const container = await promisify(execFile)("/opt/homebrew/bin/docker", ["inspect", "--format", "{{.State.Running}}", report.container]);
assert.equal(container.stdout.trim(), "false");
const env = parseEnv(await readFile("/Users/barry/apps/crawlv3-gnc-live-ioVGhu/.env.r2", "utf8"));
assert.equal(env.CLOUDFLARE_R2_BUCKET, "supply-smart-test");
assert.equal(report.prefix, `crawlv3-acceptance/gnc-e2e-${report.id}`);
const client = new S3Client({ region: "auto", endpoint: env.CLOUDFLARE_R2_ENDPOINT,
  credentials: { accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID, secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY } });
try {
  async function get(key) {
    assert.ok(typeof key === "string" && !key.startsWith("/") && !key.split("/").includes(".."));
    const result = await client.send(new GetObjectCommand({ Bucket: env.CLOUDFLARE_R2_BUCKET, Key: `${report.prefix}/${key}` }));
    return Buffer.from(await result.Body.transformToByteArray());
  }
  const base = `v3/gnc/${task.capture.operationId}`;
  const intent = JSON.parse((await get(`${base}/execution.json`)).toString());
  const received = JSON.parse((await get(`${base}/received.json`)).toString());
  assert.deepEqual(intent.input, task);
  assert.deepEqual(received.input, task);
  assert.equal(received.nonce, intent.nonce);
  const ref = received.source;
  assert.equal(ref.objectKey, `${base}/source.html`);
  assert.equal(ref.observationId, task.owner.observationId);
  assert.equal(ref.producer.operationId, task.capture.operationId);
  const bytes = await get(ref.objectKey);
  assert.equal(bytes.length, ref.byteSize);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), ref.sha256);
  // Review is durable in Postgres with a local journal, not an R2 object.
  assert.match(report.outcome.evidenceKey, /^gnc-reviews\/gnc-[a-f0-9]{64}\.json$/);
  const review = JSON.parse(await readFile(join(root, "gnc-product", "journal", report.outcome.evidenceKey), "utf8"));
  assert.deepEqual(review, database.reviews[0].record);
  assert.equal(review.reviewId, report.outcome.reviewId);
  assert.equal(review.failure.code, "GNC.ACCESS_CHALLENGE");
  assert.deepEqual(review.observation, task.owner);
  const proof = { at: new Date().toISOString(), workflowId: report.workflowId, lane: report.lane.laneId,
    sourceBytes: bytes.length, sourceSha256: ref.sha256, sourceHashVerified: true, receivedIntentVerified: true,
    reviewDatabaseMatchesLocalJournal: true, reviewCount: 1, collectedCount: 0, providerStages: 0,
    workersAlive: 0, browserAlive: false, laneReleased: true, databaseStoppedRetained: true };
  await writeFile(join(root, "review-verification.json"), JSON.stringify(proof, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(proof));
} finally { client.destroy(); }
