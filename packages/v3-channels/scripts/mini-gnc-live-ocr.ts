import { readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { hostname } from "node:os";
import { parseEnv, isDeepStrictEqual as equal } from "node:util";
import { ArtifactResolver, createR2Objects, FileCopies } from "@crawl-automation/v3-artifacts";
import { FileEvidence, PrepareImageOcr } from "@crawl-automation/v3-acquisition";
import { GncProductInputSchema, OcrInputSchema, ReviewRecordSchema, type OcrRegistration } from "@crawl-automation/v3-contracts";
import { TextLocalStore } from "../../v3-text/src/files.js";
import { OcrFileModule, OcrIntents, MultipartOcr } from "../../v3-ocr/src/index.js";
import { FileCompletionJournal, OcrResultHandoff } from "../../v3-results/src/index.js";
import { digest as reviewHash } from "../../v3-review/src/codec.js";
import { RegisteredOcrEvidence } from "../../v3-vision/src/ocr-evidence.js";
import { KeywordPublication } from "../../v3-vision/src/keyword-publication.js";
import { GncCaptureEvidence, GncProductPlans } from "../src/index.js";

// Mini-only bounded acceptance. Real modules and R2; the registration ledger is an
// isolated immutable file journal, NOT PostgreSQL/production registration or Temporal.
async function main() {
  const [mode, captureRoot, runLabel = "gallery-v2"] = process.argv.slice(2);
  if (!["image-prepare", "ocr", "ocr-cold", "keywords"].includes(mode ?? "") || !captureRoot || !isAbsolute(captureRoot) ||
    !/^barrydeMac-mini(?:\.|$)/.test(hostname()) || process.env.V3_GNC_SINGLE_LIVE !== "true") throw Error("MINI_OPT_IN_REQUIRED");
  if (!/^gallery-v2(?:-[a-z0-9-]{1,40})?$/.test(runLabel)) throw Error("INVALID_OPTION");
  const root = join(captureRoot, runLabel), state = JSON.parse(await readFile(join(captureRoot, "attempt.json"), "utf8"));
  const saved = JSON.parse(await readFile(join(root, "product-plan.json"), "utf8")), input = GncProductInputSchema.parse(saved.input);
  if (state.scope.bucket !== "supply-smart-test" || !/^crawlv3-acceptance\/gnc-live-[a-f0-9-]{36}$/.test(state.scope.prefix) ||
    input.parseVersion !== "gnc-product-html/2" || !equal(input.task, state.input)) throw Error("SCOPE_MISMATCH");
  const env = parseEnv(await readFile(join(captureRoot, ".env.r2"), "utf8"));
  if (env.CLOUDFLARE_R2_ENDPOINT !== state.scope.endpoint || env.CLOUDFLARE_R2_BUCKET !== state.scope.bucket) throw Error("R2_SCOPE_MISMATCH");
  await writeFile(join(root, `${mode}-attempt.json`), JSON.stringify({ at: new Date().toISOString(), pid: process.pid }), { flag: "wx", mode: 0o600 });
  const r2 = createR2Objects(state.scope, { accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID!, secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY! });
  const provider = new MultipartOcr({ endpoint: "http://192.168.0.6:8081/ocr", trustedHttpOrigin: "http://192.168.0.6:8081", minScore: 0.3, provider: "paddle-ocr/1" });
  let gets = 0, puts = 0, ocrCalls = 0;
  const signal = () => AbortSignal.timeout(180000), local = await TextLocalStore.open(join(root, mode + "-journal"));
  const remote = { read: (...a: Parameters<typeof r2.store.read>) => { gets++; return r2.store.read(...a); },
    create: (...a: Parameters<typeof r2.store.create>) => { puts++; if (mode === "ocr-cold") throw Error("COLD_PUT_DENIED"); return r2.store.create(...a); } };
  const reviewStore = await TextLocalStore.open(join(root, "processing-reviews"));
  const reviews = {
    read: async (id: string) => { const b = await reviewStore.read(`reviews/${id}.json`, 8388608, signal()); return b ? ReviewRecordSchema.parse(JSON.parse(Buffer.from(b).toString())) : null; },
    append: async (raw: unknown) => {
      const r = ReviewRecordSchema.parse(raw), key = `reviews/${r.reviewId}.json`;
      await reviewStore.create(key, Buffer.from(JSON.stringify(r)), "application/json", signal());
      const bytes = await reviewStore.read(key, 8388608, signal());
      if (!bytes || !equal(JSON.parse(Buffer.from(bytes).toString()), r)) throw Error("REVIEW.CONFLICT");
      return { reviewId: r.reviewId, recordHash: reviewHash(r), registered: true as const };
    },
  };
  const copies = await FileCopies.open(join(root, mode + "-cache")), resolver = new ArtifactResolver(copies, remote);
  const ledger = await FileCompletionJournal.open(join(root, "isolated-ocr-registry"));
  const registry = { read: (id: string) => ledger.read(id), register: async (r: OcrRegistration) => {
    if (mode !== "ocr") throw Error("REGISTRATION_DENIED"); await ledger.create(r);
  } };
  const journal = await FileCompletionJournal.open(join(root, mode + "-completion-journal"));
  const results = new OcrResultHandoff("gnc-live-r2/1", copies, remote, journal, registry);
  try {
    const plan = await new GncProductPlans(new GncCaptureEvidence({ local, remote, reviews })).inspect(input, signal());
    if (!plan) throw Error("PLAN_NOT_DURABLE");
    const files = plan.manifest.sources.filter(s => s.kind === "file-image");
    if (files.length !== 4 || !equal(input.ocr, provider.supported)) throw Error("INPUT_MISMATCH");
    let report: object;
    if (mode === "image-prepare") {
      const module = new PrepareImageOcr(new FileEvidence({ local, remote, reviews, copies }));
      const prepared = [];
      for (const source of files) prepared.push({ id: source.id, outcome: await module.run({ plan: source.plan, receipt: null }, signal()) });
      report = { status: prepared.every(p => p.outcome.status === "prepared") ? "prepared" : "review", prepared };
    } else {
      const prepared = JSON.parse(await readFile(join(root, "image-prepare-report.json"), "utf8"));
      if (prepared.status !== "prepared" || prepared.prepared.length !== files.length) throw Error("OCR_INPUTS_NOT_READY");
      const tasks = prepared.prepared.map((p: any, index: number) => {
        const task = OcrInputSchema.parse(p.outcome.task), source = files[index]!;
        if (p.id !== source.id || task.operationId !== source.plan.ocrOperationId || task.file.artifactId !== source.plan.imageId) throw Error("INPUT_MISMATCH");
        return { id: source.id, task };
      }) as { id: string; task: ReturnType<typeof OcrInputSchema.parse> }[];
      if (mode === "keywords") {
        const evidence = new RegisteredOcrEvidence(resolver, results, registry), publisher = new KeywordPublication(local, remote), selections = [];
        for (const { id, task } of tasks) {
          const registered = await registry.read(task.operationId); if (!registered) throw Error("OCR_NOT_REGISTERED");
          const selection = await evidence.screen(registered, signal()), receipt = await publisher.publish(selection, signal());
          selections.push({ id, selection, ...receipt });
        }
        report = { status: "screened", selections };
      } else {
        const observed = { provider: provider.provider, supported: provider.supported, close: () => provider.close(),
          recognize: (...a: Parameters<typeof provider.recognize>) => {
            if (mode !== "ocr") throw Error("COLD_OCR_DENIED"); ocrCalls++; return provider.recognize(...a);
          } };
        const module = new OcrFileModule({ provider: observed, artifacts: resolver, results, reviews,
          intents: new OcrIntents(remote, `mini-${mode}`, "gnc-live-r2/1") }), outcomes = [];
        for (let i = 0; i < tasks.length; i += 2) outcomes.push(...await Promise.all(tasks.slice(i, i + 2).map(async ({ id, task }) =>
          ({ id, outcome: await module.run(task, signal()) }))));
        report = { status: outcomes.every(o => o.outcome.status === "registered") ? "registered" : "review", outcomes };
      }
    }
    const summary = { ...report, gets, puts, ocrCalls, registry: "isolated-file-journal", temporal: false, models: 0, productCollected: false };
    await writeFile(join(root, `${mode}-report.json`), JSON.stringify(summary, null, 2), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ mode, status: (report as { status: string }).status, gets, puts, ocrCalls,
      registry: summary.registry, models: 0, productCollected: false,
      ...("selections" in report ? { selections: (report as { selections: { id: string; selection: { status: string; matchedKeywords: string[] } }[] }).selections
        .map(s => ({ id: s.id, status: s.selection.status, keywords: s.selection.matchedKeywords })) } : {}) }));
  } finally { await provider.close(); r2.close(); }
}
main().catch(e => { const code = e?.code ?? e?.message; console.error(JSON.stringify({ status: "LIVE_OCR_UNRESOLVED",
  code: typeof code === "string" && /^[A-Z_.]+$/.test(code) ? code : "REDACTED" })); process.exitCode = 1; });
