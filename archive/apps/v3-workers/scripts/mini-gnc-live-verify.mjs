// Read-only replay/evidence verification. No provider execution or artifact writes to R2.
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { Worker } from "@temporalio/worker";
const require = createRequire(import.meta.url), proto = require("@temporalio/proto");
const [live, bundle, outputMode] = process.argv.slice(2);
assert.ok(outputMode === undefined || outputMode === "--summary");
assert.match(live ?? "", /^\/Users\/barry\/apps\/crawlv3-gnc-(?:pool|saved)\.[A-Za-z0-9]+\/live$/);
assert.match(bundle ?? "", /^\/Users\/barry\/apps\/crawlv3-[A-Za-z0-9.-]+\/(?:gnc-live\/)?product-workflows\.cjs$/);
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
const report = JSON.parse(await readFile(join(live, "report.json"), "utf8"));
assert.equal(report.status, "finished");
const saved = JSON.parse(await readFile(join(live, "history.json"), "utf8"));
// This is protobuf's native toJSON format (seconds/nanos objects), not Temporal CLI's proto-JSON format.
const history = proto.temporal.api.history.v1.History.fromObject(saved);
await Worker.runReplayHistory({ workflowBundle: { codePath: bundle } }, history, report.workflowId);
const env = parseEnv(await readFile("/Users/barry/apps/crawlv3-gnc-live-ioVGhu/.env.r2", "utf8"));
assert.equal(env.CLOUDFLARE_R2_BUCKET, "supply-smart-test");
const client = new S3Client({ region: "auto", endpoint: env.CLOUDFLARE_R2_ENDPOINT,
  credentials: { accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID, secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY } });
try {
  if (report.inputMode === "saved-core-activity-only") {
    const input = JSON.parse(await readFile(join(live, "workflow-input.json"), "utf8"));
    assert.equal(report.outcome.status, "prepared"); assert.deepEqual(report.outcome.input, input.input);
    const verified = [];
    async function document(ref) {
      assert.ok(typeof ref.objectKey === "string" && !ref.objectKey.startsWith("/") && !ref.objectKey.split("/").includes(".."));
      const result = await client.send(new GetObjectCommand({ Bucket: env.CLOUDFLARE_R2_BUCKET, Key: `${report.prefix}/${ref.objectKey}` }));
      const bytes = await result.Body.transformToByteArray();
      assert.equal(bytes.length, ref.byteSize); assert.equal(createHash("sha256").update(bytes).digest("hex"), ref.sha256);
      verified.push(ref.objectKey); return Buffer.from(bytes);
    }
    const full = JSON.parse((await document(input.input.fullDocument)).toString("utf8"));
    const core = JSON.parse((await document(report.outcome.document)).toString("utf8"));
    await document(core.source); assert.deepEqual(core.source, full.source);
    assert.equal(core.producer, "label.core.prepare"); assert.equal(core.corePolicy, "gnc-label-core/1");
    assert.equal(report.outcome.range.end, core.text.length); assert.equal(report.outcome.range.start, 0);
    const previous = JSON.parse(await readFile("/Users/barry/apps/crawlv3-gnc-saved.NOu1w2/live/saved-evidence.json", "utf8"));
    assert.deepEqual(report.outcome.document, previous.corePreparation.document);
    const activities = saved.events.filter(e => e.activityTaskScheduledEventAttributes).map(e => e.activityTaskScheduledEventAttributes);
    assert.deepEqual(activities.map(a => a.activityType.name), ["prepareLabelCore"]);
    assert.equal(activities[0].retryPolicy.maximumAttempts, 1);
    assert.deepEqual(report.workers.map(w => w.role).sort(), ["label-core-prepare", "product-label-workflow"]);
    assert.ok(report.workers.every(w => { try { process.kill(w.pid, 0); return false; } catch { return true; } }));
    assert.equal(report.collectedRows.length, 0); assert.equal(report.reviewRows.length, 0);
    const proof = { replay: "passed", inputMode: report.inputMode, verifiedArtifacts: verified.length,
      originalHtmlRetained: true, matchesPreviousCore: true, coreTextLength: core.text.length, fullTextLength: full.text.length,
      providerActivities: 0, workersAlive: 0, activities: ["prepareLabelCore"], databaseStoppedRetained: report.databaseStoppedRetained };
    await writeFile(join(live, "verification.json"), JSON.stringify(proof, null, 2), { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify(proof));
  } else {
  const listed = await client.send(new ListObjectsV2Command({ Bucket: env.CLOUDFLARE_R2_BUCKET, Prefix: report.prefix + "/", MaxKeys: 1000 }));
  assert.equal(!!listed.IsTruncated, false);
  const objects = (listed.Contents ?? []).map(o => ({ key: o.Key, size: o.Size }));
  const workflowInput = JSON.parse(await readFile(join(live, "workflow-input.json"), "utf8"));
  const rejoin = report.inputMode === "saved-registered-core-rejoin";
  const streamSaved = report.inputMode === "ego-saved-plan-readonly-files";
  const prepared = rejoin || ["saved-evidence-new-generation", "saved-evidence-core-new-generation"].includes(report.inputMode);
  let savedEvidence;
  if (prepared || streamSaved) {
    const database = JSON.parse(await readFile(join(live, "database-evidence.json"), "utf8"));
    const operationId = streamSaved ? workflowInput.input.operationId : workflowInput.manifest.operationId;
    const observation = streamSaved ? workflowInput.input.sourcePlan.task.owner : workflowInput.manifest.observation;
    const assemblyKey = `v3/label-products/${operationId}/assembly.json`;
    const response = await client.send(new GetObjectCommand({ Bucket: env.CLOUDFLARE_R2_BUCKET, Key: `${report.prefix}/${assemblyKey}` }));
    const assembly = JSON.parse(await response.Body.transformToString());
    assert.equal(assembly.input.manifest.operationId, operationId);
    assert.deepEqual(assembly.input.manifest.observation, observation);
    const refs = new Map();
    function visit(value) {
      if (!value || typeof value !== "object") return;
      if (typeof value.objectKey === "string" && /^[a-f0-9]{64}$/.test(value.sha256 ?? "") && Number.isSafeInteger(value.byteSize)) {
        if (refs.has(value.objectKey)) assert.deepEqual(refs.get(value.objectKey), { sha256: value.sha256, byteSize: value.byteSize });
        refs.set(value.objectKey, { sha256: value.sha256, byteSize: value.byteSize });
      }
      for (const nested of Object.values(value)) visit(nested);
    }
    visit(workflowInput); visit(database); visit(report.savedEvidence); visit(assembly);
    if (streamSaved) {
      const planKey = `v3/gnc-products/${workflowInput.input.sourcePlan.operationId}/plan.json`;
      const response = await client.send(new GetObjectCommand({ Bucket: env.CLOUDFLARE_R2_BUCKET, Key: `${report.prefix}/${planKey}` }));
      const plan = JSON.parse(await response.Body.transformToString());
      assert.deepEqual(plan.input, workflowInput.input.sourcePlan);
      visit(plan);
    }
    const verified = [];
    for (const [key, ref] of refs) {
      assert.ok(!key.startsWith("/") && !key.split("/").includes(".."));
      const response = await client.send(new GetObjectCommand({ Bucket: env.CLOUDFLARE_R2_BUCKET, Key: `${report.prefix}/${key}` }));
      const bytes = await response.Body.transformToByteArray();
      assert.equal(bytes.length, ref.byteSize); assert.equal(createHash("sha256").update(bytes).digest("hex"), ref.sha256);
      verified.push({ key, ...ref });
      // Follow artifact references in verified JSON, including original HTML/image/OCR closure.
      if (key.endsWith(".json")) visit(JSON.parse(Buffer.from(bytes).toString("utf8")));
    }
    assert.equal(database.products.length, report.collectedRows.length);
    const imported = report.savedEvidence?.importedHistoricalOcr ?? [];
    savedEvidence = { ...report.savedEvidence, verifiedArtifacts: verified, assemblyKey, assemblyStatus: assembly.result.status,
      sourceStates: assembly.input.states, newResultOperations: rejoin ? [] : database.results.map(r => r.record.input.operationId).filter(id => !imported.includes(id)) };
    savedEvidence.productSummaries = database.products.map(({record: p}) => ({
      codec: p.codec, comparisonPolicy: p.comparisonPolicy, formulaRows: p.formula.columns.reduce((n, c) => n + c.rows.length, 0),
      otherIngredients: p.otherIngredients?.items.length, ingredients: p.ingredients.length,
      servingsPerContainerUnresolved: p.formula.servingsPerContainer === null, warningCodes: p.warnings.map(w => w.code),
    }));
    if (rejoin) {
      assert.match(report.savedEvidence.priorRun, /^\/Users\/barry\/apps\/crawlv3-gnc-saved\.[A-Za-z0-9]+\/live$/);
      for (const [file, hash] of [["database-evidence.json", report.savedEvidence.priorSnapshotSha256], ["workflow-input.json", report.savedEvidence.priorInputSha256]])
        assert.equal(createHash("sha256").update(await readFile(join(report.savedEvidence.priorRun, file))).digest("hex"), hash);
      const prior = JSON.parse(await readFile(join(report.savedEvidence.priorRun, "database-evidence.json"), "utf8"));
      const records = rows => new Map(rows.map(r => [r.record.input.operationId, r.record]));
      assert.deepEqual(records(database.results), records(prior.results));
      savedEvidence.priorSnapshotUnchanged = true;
      savedEvidence.registeredResultsReusedUnchanged = true;
    }
  }
  let intentVerified = false;
  if (!prepared) {
  const captureId = workflowInput.input.sourcePlan.task.capture.operationId;
  const keys = objects.filter(o => o.key.endsWith("/execution.json"));
  for (const {key} of keys) {
  const result = await client.send(new GetObjectCommand({ Bucket: env.CLOUDFLARE_R2_BUCKET, Key: key }));
  const intent = JSON.parse(await result.Body.transformToString());
  if (intent.input?.capture?.operationId === captureId) { intentVerified = true; break; }
  }
  assert.ok(intentVerified);
  }
  const workersAlive = report.workers.filter(w => { try { process.kill(w.pid, 0); return true; } catch { return false; } }).map(w => w.role);
  assert.deepEqual(workersAlive, []);
  const activities = saved.events.filter(e => e.activityTaskScheduledEventAttributes).map(e => ({
    activity: e.activityTaskScheduledEventAttributes.activityType.name, maximumAttempts: e.activityTaskScheduledEventAttributes.retryPolicy?.maximumAttempts }));
  assert.ok(activities.every(a => a.maximumAttempts === 1));
  if (streamSaved) {
    assert.equal(activities.filter(a => a.activity === "acquireSourceFile").length, 4);
    assert.equal(activities.filter(a => a.activity === "ocrFile").length, 4);
    assert.equal(activities.filter(a => a.activity === "interpretText").length, 1);
    assert.equal(activities.filter(a => a.activity === "interpretImage").length, 1);
    assert.ok(!activities.some(a => ["captureGncProduct", "prepareGncProduct"].includes(a.activity)));
    assert.ok(report.workers.some(w => w.role === "file-receipt"));
    assert.ok(!report.workers.some(w => ["gnc-product", "gnc-file"].includes(w.role)));
    const time = event => event ? Number(event.eventTime.seconds) * 1000 + Number(event.eventTime.nanos ?? 0) / 1000000 : null;
    const spans = saved.events.filter(e => ["ocrFile", "interpretText", "interpretImage"].includes(e.activityTaskScheduledEventAttributes?.activityType?.name)).map(e => ({
      activity: e.activityTaskScheduledEventAttributes.activityType.name,
      startedMs: time(saved.events.find(s => String(s.activityTaskStartedEventAttributes?.scheduledEventId) === String(e.eventId))),
      endedMs: time(saved.events.find(s => String(s.activityTaskCompletedEventAttributes?.scheduledEventId ?? s.activityTaskFailedEventAttributes?.scheduledEventId) === String(e.eventId))),
    }));
    const overlap = (a, b) => a.startedMs !== null && b.startedMs !== null && a.endedMs !== null && b.endedMs !== null &&
      Math.max(a.startedMs, b.startedMs) < Math.min(a.endedMs, b.endedMs);
    savedEvidence.activitySpans = spans;
    savedEvidence.activitiesOverlapped = spans.some((a, i) => spans.slice(i + 1).some(b => overlap(a, b)));
    savedEvidence.ocrCallsOverlapped = spans.some((a, i) => a.activity === "ocrFile" && spans.slice(i + 1).some(b => b.activity === "ocrFile" && overlap(a, b)));
    savedEvidence.modelCallsOverlapped = spans.some(a => a.activity === "interpretText" && spans.some(b => b.activity === "interpretImage" && overlap(a, b)));
    savedEvidence.sourceDownloads = 0; savedEvidence.browserCalls = 0;
  }
  if (rejoin) {
    assert.deepEqual(activities.map(a => a.activity), ["assembleLabelProduct", "collectLabelProduct"]);
    assert.deepEqual(report.workers.map(w => w.role).sort(), ["product-core-assembly", "product-core-collect", "product-label-workflow"]);
  } else if (prepared) {
    assert.equal(activities.filter(a => a.activity === "interpretText").length, 1);
    assert.equal(activities.filter(a => a.activity === "interpretImage").length, 1);
    assert.ok(!activities.some(a => /ocr|capture|acquire|prepareGnc/i.test(a.activity)));
    const spans = saved.events.filter(e => ["interpretText", "interpretImage"].includes(e.activityTaskScheduledEventAttributes?.activityType?.name)).map(e => {
      const started = saved.events.find(s => String(s.activityTaskStartedEventAttributes?.scheduledEventId) === String(e.eventId));
      const ended = saved.events.find(s => String(s.activityTaskCompletedEventAttributes?.scheduledEventId ?? s.activityTaskFailedEventAttributes?.scheduledEventId) === String(e.eventId));
      const time = event => event ? Number(event.eventTime.seconds) * 1000 + Number(event.eventTime.nanos ?? 0) / 1000000 : null;
      return { activity: e.activityTaskScheduledEventAttributes.activityType.name, startedMs: time(started), endedMs: time(ended) };
    });
    savedEvidence.activitySpans = spans;
    savedEvidence.activitiesOverlapped = spans.every(s => s.startedMs !== null && s.endedMs !== null) &&
      Math.max(...spans.map(s => s.startedMs)) < Math.min(...spans.map(s => s.endedMs));
  }
  const proof = { at: new Date().toISOString(), replay: "passed", workflowId: report.workflowId, namespace: report.namespace,
    inputMode: report.inputMode, objectsScope: prepared || streamSaved ? "shared-historical-evidence-prefix-not-all-new" : "new-run-prefix",
    objects, ...(prepared || streamSaved ? { savedEvidence } : {}), ...(!prepared ? { intentVerified, sourceHtmlRetained: objects.some(o => o.key.endsWith("/source.html")) } : {}), workersAlive, activities,
    providerStagesScheduled: activities.filter(a => ["ocrFile", "interpretText", "interpretImage"].includes(a.activity)).length,
    reviewRows: report.reviewRows, resultRows: report.resultRows.length, collectedRows: report.collectedRows.length };
  await writeFile(join(live, "verification.json"), JSON.stringify(proof, null, 2), { mode: 0o600, flag: "wx" });
  // Keep full provenance on the source host; routine remote diagnostics need only counts/codes.
  console.log(JSON.stringify(outputMode === "--summary" ? {
    replay: proof.replay, inputMode: proof.inputMode,
    verifiedArtifacts: savedEvidence?.verifiedArtifacts.length ?? 0,
    assemblyStatus: savedEvidence?.assemblyStatus,
    activitiesOverlapped: savedEvidence?.activitiesOverlapped,
    ocrCallsOverlapped: savedEvidence?.ocrCallsOverlapped, modelCallsOverlapped: savedEvidence?.modelCallsOverlapped,
    workersAlive: workersAlive.length, activities,
    reviewCodes: report.reviewRows.map(r => r.code),
    resultRows: proof.resultRows, collectedRows: proof.collectedRows,
    productSummaries: savedEvidence?.productSummaries, priorSnapshotUnchanged: savedEvidence?.priorSnapshotUnchanged,
    registeredResultsReusedUnchanged: savedEvidence?.registeredResultsReusedUnchanged,
  } : proof));
  }
} finally { client.destroy(); }
