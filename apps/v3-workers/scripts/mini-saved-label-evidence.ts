import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { GncLabelOutcomeSchema, LabelProductWorkflowInputSchema, VisionRecordSchema, TextRecordSchema, TextDocumentSchema, TextInputSchema, textFingerprint, textObservation, type TextCompatibility } from "@crawl-automation/v3-contracts";
import { ArtifactResolver, FileCopies, createR2Objects, sha256 } from "@crawl-automation/v3-artifacts";
import { LabelCorePreparation } from "@crawl-automation/v3-acquisition";
import { FileCompletionJournal, OcrResultHandoff, PostgresResultRegistry, validateRecord } from "@crawl-automation/v3-results";
import { RegisteredOcrEvidence, PostgresVisionRegistry } from "@crawl-automation/v3-vision";
import { PostgresTextRegistry } from "@crawl-automation/v3-text";
import { renewSavedLabelManifest } from "./saved-label-input.js";

export const savedGncPrefix = "crawlv3-acceptance/gnc-live-19c120bf-a716-4333-b005-e015babea3c3";
export const savedGncStorageId = "gnc-live-r2/1";
/** No browser/OCR/provider execution. Core opt-in may publish a content-addressed preparation; only verified OCR receipts are imported. */
export async function prepareSavedGnc(options: {
  root: string; dist: string; operationId: string; text: TextCompatibility; visionFingerprint: string; db: pg.Pool;
  corePreparation?: boolean;
  registeredRun?: string;
  storage: { r2: Parameters<typeof createR2Objects>[0]; r2Credentials: Parameters<typeof createR2Objects>[1] };
}) {
  const { root, dist, storage } = options;
  assert.equal(storage.r2.bucket, "supply-smart-test"); assert.equal(storage.r2.prefix, savedGncPrefix);
  const snapshot = JSON.parse(await readFile(join(dist, "saved-gnc-manifest.json"), "utf8"));
  const original = GncLabelOutcomeSchema.parse(snapshot.result);
  assert.equal(original.status, "prepared"); if (original.status !== "prepared") throw Error("SAVED_NOT_PREPARED");
  assert.equal(original.manifest.operationId, "gnc-label-manifest-bridge-1");
  assert.equal(original.manifest.observation.observationId, "obs-19c120bf-a716-4333-b005-e015babea3c3");
  assert.equal(original.manifest.observation.listingId, "613701");
  assert.equal(original.input.sourcePlan.task.capture.url, "https://www.gnc.com/energy/613701.html");
  const r2 = createR2Objects(storage.r2, storage.r2Credentials), signal = AbortSignal.timeout(180000);
  let reads = 0;
  const remote = { read: (...args: Parameters<typeof r2.store.read>) => { reads++; return r2.store.read(...args); },
    create: async (): Promise<never> => { throw Error("SAVED_EVIDENCE_WRITE_DENIED"); } };
  try {
    const bytes = await remote.read(original.evidenceKey, 2 * 1024 * 1024, signal);
    assert.ok(bytes, "SAVED_MANIFEST_MISSING");
    assert.deepEqual(GncLabelOutcomeSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8"))), original);
    const copies = await FileCopies.open(join(root, "saved-evidence/cache")), resolver = new ArtifactResolver(copies, remote);
    const journal = await FileCompletionJournal.open(join(root, "saved-evidence/ocr-journal"));
    const registry = new PostgresResultRegistry(options.db), handoff = new OcrResultHandoff(savedGncStorageId, copies, remote, journal, registry);
    const ocr = new RegisteredOcrEvidence(resolver, handoff, registry), imported: string[] = [];
    for (const source of original.manifest.sources) {
      if (source.kind === "text") {
        assert.equal(source.task.source.kind, "prepared"); if (source.task.source.kind !== "prepared") throw Error("SAVED_SOURCE_INVALID");
        const owner = textObservation(source.task), resolved = await resolver.resolve(source.task.source.document, owner, signal);
        const document = TextDocumentSchema.parse(JSON.parse(Buffer.from(resolved.bytes).toString("utf8")));
        assert.deepEqual(textObservation(document), owner);
        assert.ok(source.task.range.end <= document.text.length);
        await resolver.resolve(document.source, owner, signal); // Original HTML also has to remain verifiable.
      } else {
        const selection = source.task.input.selection;
        const path = join("/Users/barry/apps/crawlv3-gnc-live-ioVGhu/gallery-v2-renewal/isolated-ocr-registry", `${selection.ocrOperationId}.json`);
        const record = validateRecord(JSON.parse(await readFile(path, "utf8")));
        assert.equal(record.input.operationId, selection.ocrOperationId);
        assert.deepEqual(record.input.file, selection.image);
        await journal.create(record);
        const before = await handoff.inspect(record.input, signal);
        assert.ok(before.artifactDurable, "SAVED_OCR_NOT_DURABLE");
        const after = await handoff.register(record.input, signal);
        assert.ok(after.resultRegistered && after.artifactDurable);
        await ocr.verifiedText(selection, signal);
        imported.push(record.input.operationId);
      }
    }
    if (options.registeredRun) {
      assert.match(options.registeredRun, /^\/Users\/barry\/apps\/crawlv3-gnc-saved\.[A-Za-z0-9]+\/live$/);
      const priorInputBytes = await readFile(join(options.registeredRun, "workflow-input.json"));
      const prior = LabelProductWorkflowInputSchema.parse(JSON.parse(priorInputBytes.toString("utf8")));
      assert.deepEqual(prior.manifest.observation, original.manifest.observation);
      assert.equal(prior.manifest.admission?.comparison, "label-typography/1");
      const snapshotBytes = await readFile(join(options.registeredRun, "database-evidence.json"));
      const previous = JSON.parse(snapshotBytes.toString("utf8"));
      const textRegistry = new PostgresTextRegistry(options.db), visionRegistry = new PostgresVisionRegistry(options.db);
      for (const source of prior.manifest.sources) {
        const op = source.kind === "text" ? source.task.operationId : source.task.input.operationId;
        const records = previous.results.filter((r: any) => r.record.input.operationId === op);
        assert.equal(records.length, 1);
        if (source.kind === "text") {
          const record = TextRecordSchema.parse(records[0].record); assert.deepEqual(record.input, source.task);
          await textRegistry.register(record);
        } else {
          const record = VisionRecordSchema.parse(records[0].record);
          assert.deepEqual({ input: record.input, configFingerprint: record.configFingerprint }, source.task);
          await visionRegistry.register(record);
        }
      }
      // Registrations are imported into a NEW DB only. Assembly/collector independently reverify
      // original R2 results, completion receipts, source HTML/image, and OCR before any product INSERT.
      const manifest = structuredClone(prior.manifest); manifest.operationId = options.operationId;
      manifest.admission!.comparison = "label-typography/2";
      return { manifest, evidence: { importedHistoricalOcr: imported, importedModelResults: prior.manifest.sources.length,
        priorRun: options.registeredRun, priorSnapshotSha256: sha256(snapshotBytes), priorInputSha256: sha256(priorInputBytes),
        verifiedSources: original.manifest.sources.length, browserCalls: 0, ocrCalls: 0, modelCalls: 0, reads, writes: 0 } };
    }
    const manifest = renewSavedLabelManifest(original.manifest, options.operationId, options.text, options.visionFingerprint);
    let coreEvidence: Record<string, unknown> | undefined;
    if (options.corePreparation) {
      const source = manifest.sources.find(s => s.kind === "text");
      assert.ok(source?.kind === "text" && source.task.source.kind === "prepared");
      if (!source || source.kind !== "text" || source.task.source.kind !== "prepared") throw Error("SAVED_SOURCE_INVALID");
      const full = source.task.source.document;
      const document = TextDocumentSchema.parse(JSON.parse(Buffer.from((await resolver.resolve(full, manifest.observation, signal)).bytes).toString("utf8")));
      const core = await new LabelCorePreparation(resolver, r2.store).run(manifest.observation, document.source, signal);
      const { inputFingerprint: _old, ...unsigned } = source.task;
      const next = { ...unsigned, source: { kind: "prepared" as const, document: core.ref }, range: { start: 0, end: core.document.text.length } };
      source.task = TextInputSchema.parse({ ...next, inputFingerprint: textFingerprint(next, s => sha256(Buffer.from(s))) });
      manifest.admission = { policy: "label-packaging/1", comparison: "label-typography/2", documents: [full] };
      coreEvidence = { policy: core.document.corePolicy, document: core.ref, original: document.source, fullDocument: full,
        fullLength: document.text.length, coreLength: core.document.text.length, contentAddressedPublication: true };
    }
    return { manifest, evidence: { originalManifestKey: original.evidenceKey, originalOperationId: original.manifest.operationId,
      observationId: manifest.observation.observationId, importedHistoricalOcr: imported, verifiedSources: manifest.sources.length,
      reads, writes: options.corePreparation ? "content-addressed-core-only" : 0, ...(coreEvidence ? { corePreparation: coreEvidence } : {}), browserCalls: 0, ocrCalls: 0, oldModelResultsImported: 0 } };
  } finally { r2.close(); }
}
