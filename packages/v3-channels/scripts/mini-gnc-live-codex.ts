import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { parseEnv, isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import { createR2Objects, FileCopies, ArtifactResolver, sha256 } from "@crawl-automation/v3-artifacts";
import { PageEvidence, PreparePageModule, PreparePageText, FileEvidence } from "@crawl-automation/v3-acquisition";
import { GncProductInputSchema, KeywordResultSchema, VisionTaskSchema, VisionRecordSchema, TextInputSchema, TextRecordSchema, TextOutputSchema, TextCandidateV3Schema, LabelProductJoinSchema, textFingerprint, type VisionTask } from "@crawl-automation/v3-contracts";
import { LabelProductAssembly } from "../../v3-product/src/label-product.js";
import { SavedSourceEvidence } from "../../v3-product/src/saved-sources.js";
import { decodeTextResult } from "../../v3-text/src/protocol.js";
import { GncCaptureEvidence, GncProductPlans, GncLabelPlans } from "../src/index.js";
import { TextLocalStore } from "../../v3-text/src/files.js";
import { CodexTextProvider } from "../../v3-text/src/codex-provider.js";
import { TextModule } from "../../v3-text/src/module.js";
import { TextHandoff } from "../../v3-text/src/handoff.js";
import { TextEvidence } from "../../v3-text/src/evidence.js";
import { CodexVisionProvider } from "../../v3-vision/src/provider.js";
import { VisionModule } from "../../v3-vision/src/module.js";
import { inspectSavedVisionReview } from "../../v3-vision/src/review-recovery.js";
import { visionReviewWriter } from "../../v3-vision/src/review.js";
import { VisionHandoff } from "../../v3-vision/src/handoff.js";
import { RegisteredOcrEvidence } from "../../v3-vision/src/ocr-evidence.js";
import { keywordKey } from "../../v3-vision/src/keyword-publication.js";
import { FileCompletionJournal, OcrResultHandoff } from "../../v3-results/src/index.js";
import { CodexRpc, type CodexConnectionFactory } from "../../v3-codex/src/index.js";
import { parseRecord, digest as reviewHash } from "../../v3-review/src/codec.js";

async function main() {
  const requested = process.argv[2], label = ["label-plan", "label-vision", "label-text", "label-cold", "label-assemble", "label-manifest"].includes(requested ?? "");
  const mode = label ? requested!.slice(6) : requested;
  if (!["page-prepare", "vision", "vision-review", "text", "cold", "plan", "assemble", "manifest"].includes(mode ?? "") || ["plan", "assemble", "manifest"].includes(mode!) && !label || !/^barrydeMac-mini(?:\.|$)/.test(hostname()) || process.env.V3_GNC_SINGLE_LIVE !== "true") throw Error("MINI_OPT_IN_REQUIRED");
  const readOnly = mode === "cold" || mode === "vision-review" || mode === "plan";
  // New explicit acceptance generation: failed prior operations/Reviews remain immutable.
  const generation = label ? process.argv[3] ?? "persistent-1" : "";
  if (label && !/^[a-z][a-z0-9-]{0,40}$/.test(generation)) throw Error("GENERATION_REQUIRED");
  const stageName = (name: string) => `${label ? `label-${generation}-` : ""}codex-${name}`;
  const captureRoot = "/Users/barry/apps/crawlv3-gnc-live-ioVGhu", root = join(captureRoot, "gallery-v2-renewal");
  const stageRoot = join(root, stageName(mode!)); await mkdir(stageRoot, { mode: 0o700 });
  await writeFile(join(stageRoot, "attempt.json"), JSON.stringify({ at: new Date().toISOString(), pid: process.pid }), { flag: "wx", mode: 0o600 });
  const state = JSON.parse(await readFile(join(captureRoot, "attempt.json"), "utf8"));
  const input = GncProductInputSchema.parse(JSON.parse(await readFile(join(root, "product-plan.json"), "utf8")).input);
  const env = parseEnv(await readFile(join(captureRoot, ".env.r2"), "utf8"));
  if (!equal(input.task, state.input) || input.task.capture.url !== "https://www.gnc.com/energy/613701.html" ||
    state.scope.prefix !== "crawlv3-acceptance/gnc-live-19c120bf-a716-4333-b005-e015babea3c3" || state.scope.bucket !== "supply-smart-test" ||
    env.CLOUDFLARE_R2_ENDPOINT !== state.scope.endpoint || env.CLOUDFLARE_R2_BUCKET !== state.scope.bucket) throw Error("SCOPE_MISMATCH");
  const r2 = createR2Objects(state.scope, { accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID!, secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY! });
  const signal = () => AbortSignal.timeout(180000);
  let gets = 0, puts = 0, turns = 0;
  const providers: { close(): Promise<void> }[] = [];
  const remote = { read: (...a: Parameters<typeof r2.store.read>) => { gets++; return r2.store.read(...a); },
    create: (...a: Parameters<typeof r2.store.create>) => { puts++; if (readOnly) throw Error("READ_ONLY_PUT_DENIED"); return r2.store.create(...a); } };
  const local = await TextLocalStore.open(join(stageRoot, "journal")), ledger = await TextLocalStore.open(join(root, "isolated-codex-registry"));
  const reviewStore = await TextLocalStore.open(join(root, "processing-reviews"));
  const reviews = { read: async (id: string) => { const b = await reviewStore.read(`reviews/${id}.json`, 8388608, signal()); return b ? parseRecord(JSON.parse(Buffer.from(b).toString())) : null; },
    append: async (raw: unknown) => {
      const r = parseRecord(raw), key = `reviews/${r.reviewId}.json`; await reviewStore.create(key, Buffer.from(JSON.stringify(r)), "application/json", signal());
      const b = await reviewStore.read(key, 8388608, signal()); if (!b || !equal(JSON.parse(Buffer.from(b).toString()), r)) throw Error("REVIEW.CONFLICT");
      return { reviewId: r.reviewId, recordHash: reviewHash(r), registered: true as const };
    } };
  const registry = <T>(schema: z.ZodType<T>, kind: string) => ({
    read: async (id: string): Promise<T | null> => { const b = await ledger.read(`${kind}/${id}.json`, 1048576, signal()); return b ? schema.parse(JSON.parse(Buffer.from(b).toString())) : null; },
    register: async (raw: T) => {
      if (readOnly) throw Error("READ_ONLY_REGISTER_DENIED");
      const r = schema.parse(raw), id = (r as { input: { operationId: string } }).input.operationId, key = `${kind}/${id}.json`, bytes = Buffer.from(JSON.stringify(r));
      await ledger.create(key, bytes, "application/json", signal());
      const b = await ledger.read(key, 1048576, signal()); if (!b || !equal(JSON.parse(Buffer.from(b).toString()), r)) throw Error("REGISTRY_CONFLICT");
    },
  });
  const copies = await FileCopies.open(join(stageRoot, "cache")), resolver = new ArtifactResolver(copies, remote);
  const ocrRegistry = await FileCompletionJournal.open(join(root, "isolated-ocr-registry"));
  const ocr = new OcrResultHandoff("gnc-live-r2/1", copies, remote, await FileCompletionJournal.open(join(stageRoot, "ocr-journal")),
    { read: id => ocrRegistry.read(id), register: async () => { throw Error("OCR_REGISTER_DENIED"); } });
  const ocrEvidence = new RegisteredOcrEvidence(resolver, ocr, ocrRegistry);
  const legacyConfig = { settings: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" }, executable: "/opt/homebrew/bin/codex",
    codexHome: "/Users/barry/.codex", workRoot: join(stageRoot, "work"), runtimeProfileVersion: "gnc-live/1", timeoutMs: 240000 };
  const config = { ...legacyConfig, ...(label ? { extractionProtocol: "label-extraction/1" as const,
    runtimeProfileVersion: "gnc-persistent-auth/1" } : {}), disabledMcpServers: ["node_repl", "computer-use"] };
  const factory: CodexConnectionFactory = options => {
    const rpc = new CodexRpc({ ...options, args: [...options.args, "-c", 'cli_auth_credentials_store="file"'] }), request = rpc.request.bind(rpc);
    rpc.request = async (method, params, abort, timeout) => {
      if (method === "turn/start") {
        if (readOnly || (mode !== "text" && mode !== "vision") || ++turns > 1) throw Error("BUSINESS_TURN_DENIED");
        await writeFile(join(stageRoot, "turn-start.json"), JSON.stringify({ at: new Date().toISOString(), settings: config.settings, internalModelRequests: "codex-managed" }), { mode: 0o600, flag: "wx" });
      }
      return request(method, params, abort, timeout);
    }; return rpc;
  };
  try {
    if (!equal(CodexTextProvider.describe(legacyConfig), input.text) || CodexVisionProvider.describe(legacyConfig).configFingerprint !== input.visionConfigFingerprint) throw Error("PROFILE_MISMATCH");
    const plan = await new GncProductPlans(new GncCaptureEvidence({ local, remote, reviews })).inspect(input, signal());
    if (!plan) throw Error("PLAN_NOT_DURABLE");
    if (mode === "text" || mode === "vision") {
      const path = "/Users/barry/.codex/auth.json", stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 65536) throw Error("PRIVATE_AUTH_REQUIRED");
      // Codex owns reading and refreshing the persistent credential. Never snapshot or delete it.
    }
    const pageSource = plan.manifest.sources.find(s => s.kind === "page"); if (!pageSource || pageSource.kind !== "page") throw Error("PAGE_REQUIRED");
    let result: unknown;
    if (mode === "manifest") {
      const saved = new SavedSourceEvidence({ remote, files: new FileEvidence({ local, remote, reviews, copies }),
        pages: new PageEvidence({ local, remote, reviews }), ocr: ocrRegistry, screen: ocrEvidence, reviews });
      const manifestInput = { operationId: `gnc-label-manifest-${generation}`, sourcePlan: input,
        text: CodexTextProvider.describe(config), visionConfigFingerprint: CodexVisionProvider.describe(config).configFingerprint };
      const planner = new GncLabelPlans(new GncCaptureEvidence({ local, remote, reviews }),
        (source, s) => saved.resolve(source, { id: source.id, status: "unresolved" }, s));
      result = await planner.run(manifestInput, signal());
      if (result && (result as any).status === "prepared") {
        const before = { puts, gets }, coldRoot = join(stageRoot, "cold"), coldLocal = await TextLocalStore.open(join(coldRoot, "journal"));
        const coldCopies = await FileCopies.open(join(coldRoot, "cache"));
        const coldOcr = new OcrResultHandoff("gnc-live-r2/1", coldCopies, remote, await FileCompletionJournal.open(join(coldRoot, "ocr-journal")),
          { read: id => ocrRegistry.read(id), register: async () => { throw Error("OCR_REGISTER_DENIED"); } });
        const coldSaved = new SavedSourceEvidence({ remote, files: new FileEvidence({ local: coldLocal, remote, reviews, copies: coldCopies }),
          pages: new PageEvidence({ local: coldLocal, remote, reviews }), ocr: ocrRegistry,
          screen: new RegisteredOcrEvidence(new ArtifactResolver(coldCopies, remote), coldOcr, ocrRegistry), reviews });
        const cold = new GncLabelPlans(new GncCaptureEvidence({ local: coldLocal, remote, reviews }),
          (source, s) => coldSaved.resolve(source, { id: source.id, status: "unresolved" }, s));
        if (!equal(await cold.run(manifestInput, signal()), result) || puts !== before.puts || turns !== 0) throw Error("MANIFEST_COLD_MISMATCH");
        await writeFile(join(stageRoot, "cold-report.json"), JSON.stringify({ gets: gets - before.gets, puts: puts - before.puts, turns, sameManifest: true }), { flag: "wx", mode: 0o600 });
      }
    } else if (mode === "page-prepare") {
      const evidence = new PageEvidence({ local, remote, reviews }), receipt = await new PreparePageModule(evidence).run(pageSource.plan.page, signal());
      result = await new PreparePageText(evidence).run({ plan: pageSource.plan, receipt }, signal());
    } else {
      const keywordReport = JSON.parse(await readFile(join(root, "keywords-report.json"), "utf8"));
      const matches = keywordReport.selections.filter((s: any) => s.selection.status === "matched");
      if (matches.length !== 1 || matches[0].id !== "image-3") throw Error("ONE_LABEL_REQUIRED");
      const selection = KeywordResultSchema.parse(matches[0].selection), key = keywordKey(selection);
      const b = await remote.read(key, 1048576, signal());
      if (!b || !equal(KeywordResultSchema.parse(JSON.parse(Buffer.from(b).toString())), selection)) throw Error("SCREEN.EVIDENCE_MISMATCH");
      const file = plan.manifest.sources.find(s => s.id === "image-3");
      if (!file || file.kind !== "file-image" || file.plan.imageId !== selection.image.artifactId || file.plan.ocrOperationId !== selection.ocrOperationId) throw Error("IMAGE_IDENTITY_CONFLICT");
      const task = VisionTaskSchema.parse(label ? { input: {
        operationId: `gnclabel-${sha256(Buffer.from(JSON.stringify([file.visionOperationId, CodexVisionProvider.describe(config).configFingerprint, generation])))}`,
        selection, extractionProtocol: "label-extraction/1" }, configFingerprint: CodexVisionProvider.describe(config).configFingerprint }
        : { input: { operationId: file.visionOperationId, selection }, configFingerprint: file.configFingerprint });
      if (label) await writeFile(join(stageRoot, "vision-task.json"), JSON.stringify(task), { flag: "wx", mode: 0o600 });
      const verifyOcr = async (t: VisionTask, s: AbortSignal) => { await ocrEvidence.verifiedText(t.input.selection, s); };
      const vision = new VisionHandoff(local, remote, registry(VisionRecordSchema, "vision"), "gnc-live-r2/1", verifyOcr);
      const text = new TextHandoff(local, remote, registry(TextRecordSchema, "text"), new TextEvidence(resolver, ocr), "gnc-live-r2/1");
      if (mode === "vision-review") {
        const prior = JSON.parse(await readFile(join(root, "codex-vision/report.json"), "utf8"));
        const outcome = await inspectSavedVisionReview(task, { local, remote,
          verifiedOcrText: (selection, s) => ocrEvidence.verifiedText(selection, s) }, signal());
        if (!equal({ ...outcome, replayed: false }, prior.result)) throw Error("VISION.RECOVERY_REPORT_CONFLICT");
        const receipt = await visionReviewWriter(local, reviews)(task, outcome, signal());
        const retained = await reviews.read(receipt.reviewId);
        if (!retained || retained.failure.code !== outcome.code || !equal(retained.candidate?.value, outcome.candidate)) throw Error("VISION.REVIEW_UNVERIFIED");
        result = { ...outcome, ...receipt, reviewRegistered: true };
      } else if (mode === "vision") {
        const p = await CodexVisionProvider.open(config, process.env, factory); providers.push(p); await p.check(AbortSignal.timeout(60000));
        const prior = await vision.inspect(task, signal());
        if (prior) result = { status: "registered", record: prior, replayed: true };
        else {
          const outcome = await new VisionModule({ provider: p, store: remote, localEvidence: local,
            verifiedOcrText: (selection, s) => ocrEvidence.verifiedText(selection, s), resolve: async (image, s, owner) => (await resolver.resolve(image, owner, s)).bytes }).run(task.input, AbortSignal.timeout(360000));
          if (outcome.status === "review" || outcome.replayed) {
            const pending = outcome.status === "review" ? outcome : { ...outcome, status: "review" as const, code: "VISION.HANDOFF_PENDING" };
            result = { ...pending, ...await visionReviewWriter(local, reviews)(task, pending, signal()) };
          }
          else result = { status: "registered", outcome, record: await vision.complete(task, signal()) };
        }
      } else {
        const prep = JSON.parse(await readFile(join(root, "codex-page-prepare/report.json"), "utf8"));
        if (prep.result.status !== "prepared") throw Error("TEXT_NOT_PREPARED");
        const originalText = TextInputSchema.parse(prep.result.task);
        const page = await new PageEvidence({ local, remote, reviews }).inspect(pageSource.plan.page, signal());
        if (!page || originalText.operationId !== pageSource.plan.textOperationId || originalText.source.kind !== "prepared" || !equal(originalText.source.document, page.document)) throw Error("TEXT_IDENTITY_CONFLICT");
        const next = { ...originalText, ...CodexTextProvider.describe(config),
          operationId: `gnclabel-${sha256(Buffer.from(JSON.stringify([originalText.operationId, CodexTextProvider.describe(config).configFingerprint, generation])))}` };
        const taskText = label ? TextInputSchema.parse({ ...next, inputFingerprint: textFingerprint(next, s => sha256(Buffer.from(s))) }) : originalText;
        if (label) await writeFile(join(stageRoot, "text-task.json"), JSON.stringify(taskText), { flag: "wx", mode: 0o600 });
        if (mode === "text") {
          const p = await CodexTextProvider.open(config, process.env, factory); providers.push(p); await p.check(AbortSignal.timeout(60000));
          result = await new TextModule({ provider: p, handoff: text, reviews, nodeId: "mini-gnc-text" }).run(taskText, AbortSignal.timeout(360000));
        } else if (mode === "plan") {
          await verifyOcr(task, signal());
          const originalImage = await resolver.resolve(task.input.selection.image, task.input.selection.observation, signal());
          const document = await text.evidence.resolve(taskText, signal());
          result = { status: "planned", operationIds: [taskText.operationId, task.input.operationId],
            textRange: taskText.range, fullTextLength: document.text.length,
            imageSha256: sha256(originalImage.bytes), imageBytes: originalImage.bytes.length,
            originalOperations: [originalText.operationId, file.visionOperationId], sourcePlanReused: true };
        } else if (label) {
          const priorVision = JSON.parse(await readFile(join(root, stageName("vision"), "report.json"), "utf8")).result;
          const priorText = JSON.parse(await readFile(join(root, stageName("text"), "report.json"), "utf8")).result;
          let verifiedVision: unknown, verifiedText: unknown;
          if (priorVision.status === "registered") verifiedVision = await vision.readLabelCandidate(task, signal());
          else {
            const outcome = await inspectSavedVisionReview(task, { local, remote,
              verifiedOcrText: (selection, s) => ocrEvidence.verifiedText(selection, s) }, signal());
            const review = await reviews.read(priorVision.reviewId);
            if (!review || review.failure.operationId !== task.input.operationId || review.failure.code !== outcome.code || !equal(review.candidate?.value, outcome.candidate)) throw Error("VISION.REVIEW_UNVERIFIED");
            verifiedVision = { ...outcome, reviewId: review.reviewId };
          }
          if (priorText.status === "registered") {
            const facts = await text.inspect(taskText, signal());
            if (!facts.resultRegistered || !facts.artifactDurable || !facts.record) throw Error("TEXT_NOT_REGISTERED");
            verifiedText = facts;
          } else {
            const review = await reviews.read(priorText.reviewId), source = await text.evidence.resolve(taskText, signal());
            const raw = (review?.candidate?.value as { rawResponse?: string } | undefined)?.rawResponse;
            if (!review || review.failure.inputFingerprint !== taskText.inputFingerprint || review.failure.operationId !== taskText.operationId || !raw) throw Error("TEXT.REVIEW_UNVERIFIED");
            let code: string | undefined;
            try { decodeTextResult(taskText, source.text, raw); } catch (error) { code = (error as { code?: string }).code; }
            if (!code || code !== review.failure.code || code !== priorText.code) throw Error("TEXT.REVIEW_UNVERIFIED");
            verifiedText = { status: "review", code, reviewId: review.reviewId, rawResponseSha256: sha256(Buffer.from(raw)) };
          }
          if (mode === "assemble") {
            const joined = LabelProductJoinSchema.parse({ manifest: { operationId: `gnclabel-product-${sha256(Buffer.from(JSON.stringify([taskText.operationId, task.input.operationId])))}`,
              observation: task.input.selection.observation, sources: [{ id: "page", kind: "text", required: true, task: taskText }, { id: "back-label", kind: "image", required: true, task }] },
              states: [{ id: "page", status: priorText.status === "registered" ? "registered" : "review", ...(priorText.reviewId ? { reviewId: priorText.reviewId } : {}) },
                { id: "back-label", status: priorVision.status === "registered" ? "registered" : "review", ...(priorVision.reviewId ? { reviewId: priorVision.reviewId } : {}) }] });
            const assembly = new LabelProductAssembly({ local, remote, reviews, readSource: async (source, s) => {
              if (source.kind === "image") return { id: source.id, kind: "image", ...await vision.readLabelCandidate(source.task, s) };
              const facts = await text.inspect(source.task, s);
              if (!facts.resultRegistered || !facts.artifactDurable || !facts.record) throw Error("LABEL_PRODUCT.TEXT_UNVERIFIED");
              const bytes = await remote.read(facts.record.result.objectKey, 524288, s);
              if (!bytes) throw Error("LABEL_PRODUCT.TEXT_UNVERIFIED");
              return { id: source.id, kind: "text", record: facts.record,
                candidate: TextCandidateV3Schema.parse(TextOutputSchema.parse(JSON.parse(Buffer.from(bytes).toString())).candidate),
                fullText: (await text.evidence.resolve(source.task, s)).text };
            } });
            result = await assembly.run(joined, signal());
            await writeFile(join(stageRoot, "product-join.json"), JSON.stringify(joined), { flag: "wx", mode: 0o600 });
          } else result = { status: "verified", vision: verifiedVision, text: verifiedText,
            upstreamReady: priorVision.status === "registered" && priorText.status === "registered" };
        } else {
          const v = await vision.readCandidate(task, signal()), t = await text.inspect(taskText, signal());
          if (!t.resultRegistered || !t.artifactDurable || !t.record) throw Error("TEXT_NOT_REGISTERED");
          const bytes = await remote.read(t.record.result.objectKey, 524288, signal());
          result = { status: "verified", vision: v, text: { record: t.record, output: JSON.parse(Buffer.from(bytes!).toString()) } };
        }
      }
    }
    const report = { result, gets, puts, turns, models: config.settings, protocol: label ? "label-extraction/1" : "legacy",
      registry: "isolated-file-journal", generation, credentialMode: "persistent-default", temporal: false, productCollected: false };
    await writeFile(join(stageRoot, "report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ mode, status: (result as any).status, code: (result as any).code ?? null, gets, puts, turns, productCollected: false }));
  } catch (e: any) {
    const raw = e?.code ?? e?.message, code = typeof raw === "string" && /^[A-Z_.]+$/.test(raw) ? raw : "REDACTED";
    const report = { status: "unresolved", code, gets, puts, turns, productCollected: false };
    await writeFile(join(stageRoot, "failure.json"), JSON.stringify(report), { flag: "wx", mode: 0o600 }); console.log(JSON.stringify(report)); process.exitCode = 1;
  } finally { await Promise.all(providers.map(p => p.close())); r2.close(); }
}
main().catch(() => { console.error("CODEX_ACCEPTANCE_UNRESOLVED"); process.exitCode = 1; });
