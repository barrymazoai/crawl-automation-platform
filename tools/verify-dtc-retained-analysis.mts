/** Mini acceptance from archived analysis only; optional derived registration, never a browser retry. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { deepStrictEqual } from "node:assert/strict";
import {
  createDatabase, createLogger, createR2Objects, LocalObjectStore, RetainedPublication, sha256,
} from "../packages/platform/src/index.js";
import { PostgresSiteAnalyses } from "../packages/adapters/src/index.js";
import { SiteAnalysisService, SiteAnalysisRunner } from "../packages/app/src/index.js";
import { SiteAnalysisLimitsSchema } from "../packages/v3-contracts/src/index.js";
import { WorkerConfigSchema } from "../apps/worker/src/config.js";
import { analyzeWithDtcAgent } from "../packages/channels/dtc/src/agent/analysis.js";
import { CaptureFileSchema, captureOutputFiles } from "../packages/channels/dtc/src/agent/archive.js";

const [configPath, sourceId, output, action] = process.argv.slice(2);
if (!configPath || !sourceId || !output || (action && action !== "--register")) {
  throw new Error("Usage: <worker-config> <source-analysis-id> <new-output-dir> [--register]");
}
await mkdir(output, { mode: 0o700 });
const write = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2), { flag: "wx" });
const config = WorkerConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
const database = createDatabase(config.database, createLogger({ name: "dtc-retained-analysis" }));
const store = new PostgresSiteAnalyses(database);
const r2 = createR2Objects(config.storage.r2, config.storage.r2Credentials);
const signal = AbortSignal.timeout(300_000);
const read = async (key: string, limit: number) => {
  const bytes = await r2.store.read(key, limit, signal);
  if (!bytes) throw new Error(`Retained object missing: ${key}`);
  return Buffer.from(bytes);
};
try {
  const original = await store.get(sourceId);
  if (!original || !["failed", "needs-review", "completed"].includes(original.state)) {
    throw new Error("Source analysis must be terminal");
  }
  if (action && (original.state !== "failed" || (await store.tasks(sourceId)).length)) {
    throw new Error("Derived registration requires a failed, unapplied source analysis");
  }
  const prefix = `v3/dtc-agent/analysis-${sourceId}`;
  const manifestKey = `${prefix}/capture.json`;
  const archiveKey = `${prefix}/archive.json`;
  const archiveBytes = await read(archiveKey, 1_000_000);
  const manifestBytes = await read(manifestKey, 1_000_000);
  const archive = CaptureFileSchema.array().parse(JSON.parse(archiveBytes.toString()).files);
  const manifest = JSON.parse(manifestBytes.toString());
  if (manifest.request?.operationId !== `analysis-${sourceId}` ||
      manifest.request?.mode !== "analysis" || manifest.request?.url !== original.url) {
    throw new Error("Retained analysis identity mismatch");
  }
  deepStrictEqual(SiteAnalysisLimitsSchema.parse(manifest.request.scope), original.limits);
  const captured = captureOutputFiles(archive);
  deepStrictEqual(manifest.files, captured.files);
  deepStrictEqual(manifest.evidenceFiles, captured.evidenceFiles);
  const originalsRoot = join(output, "originals");
  const originals = await LocalObjectStore.open(originalsRoot, 32 * 1024 * 1024);
  let bytesVerified = 0;
  for (let offset = 0; offset < archive.length; offset += 4) {
    await Promise.all(archive.slice(offset, offset + 4).map(async file => {
      if (file.objectKey !== `${prefix}/files/${sha256(Buffer.from(file.path))}`) {
        throw new Error("Retained file ownership mismatch");
      }
      const bytes = await read(file.objectKey, file.byteSize);
      if (bytes.length !== file.byteSize || sha256(bytes) !== file.sha256) {
        throw new Error(`Retained file integrity mismatch: ${file.path}`);
      }
      await originals.create(file.path, bytes, file.mediaType, signal);
      bytesVerified += bytes.length;
    }));
  }
  const result = await analyzeWithDtcAgent({
    capture: async () => ({ root: join(originalsRoot, "capture"), prefix, manifestKey, ...captured }),
  }, original, signal);
  await write("validation.json", {
    at: new Date().toISOString(), source: original, archiveKey, archiveSha256: sha256(archiveBytes),
    manifestKey, manifestSha256: sha256(manifestBytes), files: archive.length, bytesVerified,
    browserCalls: 0, modelCalls: 0, result,
  });
  console.log(JSON.stringify({ stage: "validated", sourceId, files: archive.length, bytesVerified, result }));
  if (action) {
    if (result.state !== "completed") throw new Error("Retained analysis is still incomplete");
    deepStrictEqual(await store.get(sourceId), original);
    const requestId = randomUUID();
    const proofKey = `v3/dtc-retained-analysis/${requestId}/provenance.json`;
    const proof = {
      purpose: "Derived validation of retained model output; original failed analysis remains unchanged",
      sourceAnalysisId: sourceId, derivedAnalysisId: requestId,
      sourceRecordSha256: sha256(Buffer.from(JSON.stringify(original))),
      archive: { objectKey: archiveKey, sha256: sha256(archiveBytes) },
      capture: { objectKey: manifestKey, sha256: sha256(manifestBytes) },
      result, derivedAt: new Date().toISOString(), browserCalls: 0, modelCalls: 0,
    };
    await write("registration-intent.json", { requestId, proofKey, proof });
    const publication = new RetainedPublication(await LocalObjectStore.open(join(output, "publications")), r2.store);
    await publication.publish(proofKey, Buffer.from(JSON.stringify(proof)), "application/json", signal);
    const runner = new SiteAnalysisRunner({ store, analyze: async (_input, progress) => {
      await progress(manifestKey);
      await progress(proofKey);
      return { ...result, archiveKeys: [manifestKey, proofKey] };
    } });
    const service = new SiteAnalysisService({ store, limits: original.limits, gateway: {
      start: async analysis => { await runner.run(analysis, signal); },
      failure: async () => null,
    } });
    const registered = await service.analyze({ requestId, url: original.url });
    const saved = await store.get(registered.analysisId);
    if (saved?.state !== "completed") throw new Error("Derived registration did not complete");
    deepStrictEqual(await store.get(sourceId), original);
    await write("registration-result.json", saved);
    console.log(JSON.stringify({ stage: "registered", sourceId, derivedAnalysisId: saved.analysisId, proofKey }));
  }
} finally {
  r2.close();
  await database.close();
}
