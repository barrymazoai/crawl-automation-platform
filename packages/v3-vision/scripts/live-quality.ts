// Explicit, bounded quality pilot: three existing image/OCR evidence pairs, no production mutations.
import { mkdir, mkdtemp, readFile, writeFile, unlink, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { OcrResponseSchema, type Observation, type ArtifactRef } from "@crawl-automation/v3-contracts";
import { CodexVisionProvider, VisionModule, LocalVisionEvidenceStore, screenKeywords, imageProductDecision, digest } from "../src/index.js";
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();
const [sampleRootArg, ocrRootArg, authArg, executableArg] = args;
if (process.env.V3_VISION_LIVE_CONFIRM !== "three-images-luna-medium" || !sampleRootArg || !ocrRootArg || !authArg || !executableArg)
  throw Error("Usage: V3_VISION_LIVE_CONFIRM=three-images-luna-medium tsx scripts/live-quality.ts sampleRoot ocrRoot authFile codexExecutable");
const sampleRoot = resolve(sampleRootArg), ocrRoot = resolve(ocrRootArg), authSource = resolve(authArg);
const samples = [
  ["B0FMYPGLY7", "83d0982ebc950265cd6a53c9cb0bd3ee9e6433afe390b8ecb01726f472727b0b"],
  ["B0BBP7NWFR", "91e17a57662d93adbcf608d29857a1d85610058daab6b7f181071ec50ac24a42"],
  ["B09W439TMF", "3556d326245ad4250283ce6a9b9a356bf1e2638c0d519ffbb812498bbc4cf3e8"],
] as const;
const root = await mkdtemp("/private/tmp/crawlv3-vision-quality-");
const profile = join(root, "profile"); await mkdir(profile, { mode: 0o700 });
const settings = { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" };
const report: { startedAt: string; settings: typeof settings; root: string; scope: string; modelBusinessExecutions: number;
  maxBusinessExecutions: number; samples: unknown[]; dbWrites: number; r2Writes: number; temporaryAuthRemoved?: boolean; finishedAt?: string; error?: string } = {
  startedAt: new Date().toISOString(), settings, root, scope: "local-quality-pilot-stored-real-OCR-plus-original-images-not-production-registration",
  modelBusinessExecutions: 0, maxBusinessExecutions: 3, samples: [], dbWrites: 0, r2Writes: 0 };
const save = () => writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort()); process.once("SIGINT", () => stop.abort());
let provider: CodexVisionProvider | undefined;
console.log(JSON.stringify({ event: "start", root, settings }));
try {
  const s = await lstat(authSource);
  if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077)) throw Error("PRIVATE_AUTH_REQUIRED");
  await writeFile(join(profile, "auth.json"), await readFile(authSource), { mode: 0o600, flag: "wx" });
  await writeFile(join(profile, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: "wx" });
  provider = await CodexVisionProvider.open({ settings, executable: resolve(executableArg), codexHome: profile,
    workRoot: join(root, "work"), runtimeProfileVersion: "quality-0153-vision/1", timeoutMs: 240000 }, process.env);
  await provider.check(AbortSignal.any([stop.signal, AbortSignal.timeout(30000)]));
  const actualProvider = provider;
  const store = await LocalVisionEvidenceStore.open(join(root, "evidence"));
  for (const [id, hash] of samples) {
    stop.signal.throwIfAborted();
    const bytes = await readFile(join(sampleRoot, id + ".jpg"));
    if (digest(bytes) !== hash) throw Error("INPUT_CHANGED");
    const ocrBytes = await readFile(join(ocrRoot, id + "-score-0.3-response.json"));
    const ocr = OcrResponseSchema.parse(JSON.parse(ocrBytes.toString()));
    const observation: Observation = { schemaVersion: 1, requestId: "vision-quality", observationId: id,
      brandId: "ancient-nutrition", sourceId: "amazon", listingId: id, variantId: null };
    const image: ArtifactRef = { schemaVersion: 1, artifactId: id + "-image", observationId: id, sourceId: "amazon", listingId: id,
      variantId: null, sha256: hash, byteSize: bytes.length, objectKey: `pilot/${id}/source.jpg`, kind: "source-image", mediaType: "image/jpeg",
      producer: { operationId: id + "-acquisition", module: "file.acquire", implementationVersion: "quality-evidence/1" } };
    await store.create(image.objectKey, bytes, image.mediaType, stop.signal);
    await store.create(`pilot/${id}/ocr.json`, ocrBytes, "application/json", stop.signal);
    const selection = screenKeywords({ observation, image, ocrOperationId: id + "-ocr", text: ocr.text });
    await store.create(`pilot/${id}/selection.json`, Buffer.from(JSON.stringify(selection)), "application/json", stop.signal);
    const product = imageProductDecision({ observation, closed: true, imageIds: [image.artifactId] }, [selection]);
    if (selection.status !== "matched") { report.samples.push({ id, selection, product, modelExecutions: 0 }); await save(); continue; }
    const module = new VisionModule({ store, localEvidence: store, provider: { fingerprint: actualProvider.fingerprint, async interpret(ref, inputBytes, signal) {
      if (report.modelBusinessExecutions >= report.maxBusinessExecutions) throw Error("LIVE_BUDGET");
      report.modelBusinessExecutions++; await save(); return actualProvider.interpret(ref, inputBytes, signal);
    } }, async resolve(ref, signal) {
      const data = await store.read(ref.objectKey, 16 * 1024 * 1024, signal); if (!data) throw Error("MISSING_IMAGE"); return data;
    }, async verifiedOcrText(_selection, signal) {
      // This adapter verifies retained pilot bytes, NOT a production DB registration.
      const data = await store.read(`pilot/${id}/ocr.json`, 8 * 1024 * 1024, signal);
      if (!data || digest(data) !== digest(ocrBytes)) throw Error("OCR_EVIDENCE_CHANGED");
      return OcrResponseSchema.parse(JSON.parse(Buffer.from(data).toString())).text;
    } });
    console.log(JSON.stringify({ event: "sample-started", id, matched: selection.matchedKeywords }));
    const start = Date.now();
    const outcome = await module.run({ operationId: id + "-vision", selection }, stop.signal);
    const replay = await module.run({ operationId: id + "-vision", selection }, stop.signal);
    report.samples.push({ id, selection, outcome, replay, elapsedMs: Date.now() - start }); await save();
    console.log(JSON.stringify({ event: "sample-finished", id, status: outcome.status, code: outcome.code, replayed: replay.replayed, elapsedMs: Date.now() - start }));
  }
} catch (e) {
  const safe = z.object({ code: z.string().regex(/^[A-Z][A-Z_.]+$/) }).safeParse(e);
  report.error = safe.success ? safe.data.code : "VISION.QUALITY_FAILED"; process.exitCode = 1;
} finally {
  try { await provider?.close(); }
  finally { await unlink(join(profile, "auth.json")).catch(e => { if (e.code !== "ENOENT") throw e; }); }
  report.temporaryAuthRemoved = true; report.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ event: "finished", root, calls: report.modelBusinessExecutions, error: report.error }));
}
