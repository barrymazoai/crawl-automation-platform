import { lstat } from "node:fs/promises";
import pg from "pg";
import { isDeepStrictEqual } from "node:util";
import { OcrInputSchema, TextInputSchema, VisionTaskSchema } from "@crawl-automation/v3-contracts";
import { FileCopies, ArtifactResolver, createR2Objects } from "@crawl-automation/v3-artifacts";
import { FileCompletionJournal, PostgresResultRegistry, OcrResultHandoff } from "@crawl-automation/v3-results";
import { TextHandoff, TextLocalStore, TextEvidence, PostgresTextRegistry } from "@crawl-automation/v3-text";
import { VisionHandoff, LocalVisionEvidenceStore, RegisteredOcrEvidence, PostgresVisionRegistry } from "@crawl-automation/v3-vision";
import { readGncPrivateJson } from "./gnc-config.js";
import type { Effect } from "./temporal-resource-evidence.js";

/** Composition root for evidence-only readers. Intentionally does not import Codex/OCR providers or execution modules. */
export async function openRecoveryHandoff(configPath: string, activityType: string, raw: unknown, readOnly: boolean) {
  if (!["ocrFile", "interpretText", "interpretImage"].includes(activityType)) throw Error("RESOURCE_RECOVERY.EFFECT_UNSUPPORTED");
  const c = await readGncPrivateJson(configPath) as any;
  const input = activityType === "ocrFile" ? OcrInputSchema.parse(raw) : activityType === "interpretText" ? TextInputSchema.parse(raw) : VisionTaskSchema.parse(raw);
  const operationId = "operationId" in input ? input.operationId : input.input.operationId;
  const roots = [c.cacheRoot, activityType === "ocrFile" ? c.journalRoot : c.ocrJournalRoot,
    ...(activityType === "interpretText" ? [c.textLocalRoot] : activityType === "interpretImage" ? [c.visionLocalRoot] : [])];
  for (const root of roots) { const s = await lstat(root); if (!s.isDirectory() || s.isSymbolicLink()) throw Error("RESOURCE_RECOVERY.LOCAL_STORE_MISSING"); }
  const db = new pg.Pool({ connectionString: c.resultDatabase.connectionString, ssl: c.resultDatabase.tls ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 5000, statement_timeout: 5000, max: 2, ...(readOnly ? { options: "-c default_transaction_read_only=on" } : {}) });
  // This tool is scoped to the single new business database, not a separately selected old Review database.
  if (!isDeepStrictEqual(c.resultDatabase, c.reviewDatabase)) { await db.end(); throw Error("RESOURCE_RECOVERY.DATABASE_SCOPE"); }
  const remote = createR2Objects(c.r2, c.r2Credentials), signal = () => AbortSignal.timeout(30000);
  const dispose = async () => { remote.close(); await db.end(); };
  try {
    const local = await FileCopies.open(c.cacheRoot), journal = await FileCompletionJournal.open(activityType === "ocrFile" ? c.journalRoot : c.ocrJournalRoot);
    const ocr = new OcrResultHandoff(c.storageId, local, remote.store, journal, new PostgresResultRegistry(db));
    const reviewed = async () => (await db.query("SELECT 1 FROM review_record WHERE record->'failure'->>'operationId'=$1 LIMIT 1", [operationId])).rows.length > 0;
    if (activityType === "ocrFile") return { dispose, operationId, reviewed,
      inspect: async () => { const f = await ocr.inspect(input, signal()); return { computed: f.computedLocal, durable: f.artifactDurable, registered: f.resultRegistered }; },
      upload: () => ocr.uploadMissing(input, signal()), register: () => ocr.register(input, signal()),
      verify: async (output: any) => { const f = await ocr.inspect(input, signal()); if (!f.resultRegistered || !f.artifactDurable || !f.record || output.status !== "registered" || output.operationId !== operationId || !isDeepStrictEqual(output.result, f.record.result) || !isDeepStrictEqual(output.completion, f.record.completion)) throw Error("RESOURCE_RECOVERY.RECEIPT_UNVERIFIED"); } };
    const artifacts = new ArtifactResolver(readOnly ? { read: local.read.bind(local), retain: async () => {} } : local, remote.store);
    if (activityType === "interpretText") {
      const task = TextInputSchema.parse(input), handoff = new TextHandoff(await TextLocalStore.open(c.textLocalRoot), remote.store, new PostgresTextRegistry(db), new TextEvidence(artifacts, ocr), c.storageId);
      return { dispose, operationId, reviewed, inspect: () => handoff.inspectRecovery(task, signal()),
        upload: () => handoff.uploadRecoveredResponse(task, signal()), register: () => handoff.register(task, signal()),
        verify: async (output: any) => { const f = await handoff.inspect(task, signal()); if (!f.resultRegistered || !f.artifactDurable || !f.record || output.status !== "registered" || output.operationId !== operationId || !isDeepStrictEqual(output.result, f.record.result) || !isDeepStrictEqual(output.completion, f.record.completion)) throw Error("RESOURCE_RECOVERY.RECEIPT_UNVERIFIED"); } };
    }
    const task = VisionTaskSchema.parse(input), evidence = new RegisteredOcrEvidence(artifacts, ocr, new PostgresResultRegistry(db));
    const handoff = new VisionHandoff(await LocalVisionEvidenceStore.open(c.visionLocalRoot), remote.store, new PostgresVisionRegistry(db), c.storageId,
      async (t, s) => { await evidence.verifiedText(t.input.selection, s); });
    return { dispose, operationId, reviewed, inspect: () => handoff.inspectRecovery(task, signal()),
      upload: () => handoff.uploadRecoveredResponse(task, signal()), register: () => handoff.complete(task, signal()),
      verify: async (output: any) => { const f = await handoff.inspect(task, signal()); if (!f || output.status !== "registered" || output.operationId !== operationId || output.candidateStatus !== f.status || output.evidenceKey !== f.result.objectKey) throw Error("RESOURCE_RECOVERY.RECEIPT_UNVERIFIED"); } };
  } catch (e) { await dispose(); throw e; }
}
export async function verifyComputedEffect(configPath: string, effect: Effect) {
  const p = await openRecoveryHandoff(configPath, effect.activityType, effect.input, true);
  try { if (await p.reviewed()) throw Error("RESOURCE_RECOVERY.REVIEW_PRESERVED"); await p.verify(effect.output); } finally { await p.dispose(); }
}
