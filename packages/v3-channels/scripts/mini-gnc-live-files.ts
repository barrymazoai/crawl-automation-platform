import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { hostname } from "node:os";
import { parseEnv } from "node:util";
import { createR2Objects, FileCopies } from "@crawl-automation/v3-artifacts";
import { CdpFileSession, createHttpRoute, AcquireFileModule, FileEvidence, systemDns } from "@crawl-automation/v3-acquisition";
import { GncProductInputSchema } from "@crawl-automation/v3-contracts";
import { TextLocalStore } from "../../v3-text/src/files.js";
import { CodexTextProvider } from "../../v3-text/src/codex-provider.js";
import { CodexVisionProvider } from "../../v3-vision/src/provider.js";
import { MultipartOcr } from "../../v3-ocr/src/http.js";
import { GncCaptureEvidence, GncProductPlans, GncFileSources, prepareGncFileGrant } from "../src/index.js";

// Separate invocations/processes. Provisioning owns CDP; downloading has no browser reference.
async function main() {
  const [mode, captureRoot, option, runLabel = "gallery-v2"] = process.argv.slice(2);
  const reparse = option === "--reparse-v2";
  if ((option && !reparse) || !/^gallery-v2(?:-[a-z0-9-]{1,40})?$/.test(runLabel)) throw Error("INVALID_OPTION");
  const root = captureRoot && reparse ? join(captureRoot, runLabel) : captureRoot;
  if (!["prepare", "download", "cold"].includes(mode ?? "") || !root || !isAbsolute(root) || !/^barrydeMac-mini(?:\.|$)/.test(hostname()) || process.env.V3_GNC_SINGLE_LIVE !== "true") throw Error("MINI_OPT_IN_REQUIRED");
  if (!captureRoot) throw Error("CAPTURE_REQUIRED");
  const state = JSON.parse(await readFile(join(captureRoot, "attempt.json"), "utf8")), capture = JSON.parse(await readFile(join(captureRoot, "capture-report.json"), "utf8"));
  if (capture.result.status !== "durable" || state.scope.bucket !== "supply-smart-test" || !/^crawlv3-acceptance\/gnc-live-[a-f0-9-]{36}$/.test(state.scope.prefix)) throw Error("CAPTURE_NOT_READY");
  const env = parseEnv(await readFile(join(captureRoot, ".env.r2"), "utf8"));
  if (env.CLOUDFLARE_R2_ENDPOINT !== state.scope.endpoint || env.CLOUDFLARE_R2_BUCKET !== state.scope.bucket) throw Error("R2_SCOPE_MISMATCH");
  if (reparse) await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, `${mode}-attempt.json`), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, reparse }), { flag: "wx", mode: 0o600 });
  const r2 = createR2Objects(state.scope, { accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID!, secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY! });
  let gets = 0, puts = 0, downloads = 0, browserExports = 0;
  const signal = () => AbortSignal.timeout(30000), local = await TextLocalStore.open(join(root, mode + "-journal"));
  const remote = { read: (...a: Parameters<typeof r2.store.read>) => { gets++; return r2.store.read(...a); },
    create: (...a: Parameters<typeof r2.store.create>) => { puts++; if (mode === "cold") throw Error("COLD_PUT_DENIED"); return r2.store.create(...a); } };
  const reviews = { read: async (id: string) => { const b = await local.read(`reviews/${id}.json`, 8388608, signal()); return b ? JSON.parse(Buffer.from(b).toString()) : null; },
    append: async (r: any) => local.create(`reviews/${r.reviewId}.json`, Buffer.from(JSON.stringify(r)), "application/json", signal()) };
  const evidence = new GncCaptureEvidence({ local, remote, reviews }), plans = new GncProductPlans(evidence);
  try {
    if (mode === "prepare") {
      // Public semantic fingerprints only; no model/OCR preflight or execution in this acquisition acceptance.
      const codex = { settings: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" }, executable: "/opt/homebrew/bin/codex",
        codexHome: join(root, "future-codex-profile"), workRoot: join(root, "future-codex-work"), runtimeProfileVersion: "gnc-live/1", timeoutMs: 240000 };
      const ocr = new MultipartOcr({ endpoint: "http://192.168.0.6:8081/ocr", trustedHttpOrigin: "http://192.168.0.6:8081",
        minScore: 0.3, provider: "paddle-ocr/1" });
      const input = GncProductInputSchema.parse({ operationId: `product-${state.input.capture.operationId}${reparse ? "-" + runLabel : ""}`, task: state.input,
        ...(reparse ? { parseVersion: "gnc-product-html/2" } : {}),
        text: CodexTextProvider.describe(codex), ocr: ocr.supported, visionConfigFingerprint: CodexVisionProvider.describe(codex).configFingerprint });
      const prepared = await plans.run({ input, receipt: capture.result }, AbortSignal.timeout(180000));
      if (prepared.status !== "prepared") throw Error("PRODUCT_PLAN_NOT_READY");
      const files = prepared.manifest.sources.filter(s => s.kind === "file-image").map(s => s.plan.acquire);
      if (files.length > 10) throw Error("LIVE_IMAGE_LIMIT");
      await writeFile(join(root, "product-plan.json"), JSON.stringify({ input, prepared, files, downstreamAvailabilityVerified: false }), { flag: "wx", mode: 0o600 });
      const published = await plans.inspect(input, signal());
      if (published?.parsed) {
        const bytes = await remote.read(published.parsed.objectKey, 8388608, signal());
        if (!bytes) throw Error("REPARSE_NOT_DURABLE");
        await writeFile(join(root, "reparse-proof.json"), bytes, { flag: "wx", mode: 0o600 });
      }
      const browser = new CdpFileSession(state.browser); browserExports++;
      const grant = await prepareGncFileGrant(plans, browser, input, ["https://www.gnc.com"], new Date(Date.now() + 600000).toISOString(), AbortSignal.timeout(180000));
      await writeFile(join(root, "file-grant.private.json"), JSON.stringify(grant), { flag: "wx", mode: 0o600 });
      const report = { status: "prepared", files: files.length, browserExports, gets, puts, models: 0, ocrCalls: 0,
        privateCredentialsInCommonEvidence: false, downstreamAvailabilityVerified: false };
      await writeFile(join(root, "prepare-report.json"), JSON.stringify(report), { flag: "wx", mode: 0o600 }); console.log(JSON.stringify(report));
    } else {
      const plan = JSON.parse(await readFile(join(root, "product-plan.json"), "utf8"));
      const copies = await FileCopies.open(join(root, mode + "-cache")), fileEvidence = new FileEvidence({ local, remote, reviews, copies });
      let access;
      if (mode === "download") {
        const grant = JSON.parse(await readFile(join(root, "file-grant.private.json"), "utf8"));
        const route = createHttpRoute(state.input.network, { proxyUrl: state.proxyUrl });
        const transport = route.transport;
        const observed = { ...route, transport: { egressId: transport.egressId, ...(transport.targetResolution ? { targetResolution: transport.targetResolution } : {}),
          get: (...a: Parameters<typeof transport.get>) => { downloads++; return transport.get(...a); } } };
        access = new GncFileSources(plans, observed, [grant]);
      } else access = { acquire: async (): Promise<never> => { downloads++; throw Error("COLD_DOWNLOAD_DENIED"); } };
      const module = new AcquireFileModule(fileEvidence, { access, dns: systemDns }), outcomes = [];
      // Bounded concurrency 2; no per-file retry, no Cookie refresh, no network fallback.
      for (let i = 0; i < plan.files.length; i += 2) outcomes.push(...await Promise.all(plan.files.slice(i, i + 2).map((f: any) => module.run(f, AbortSignal.timeout(120000)))));
      const records = [];
      for (const f of plan.files) { const r = await fileEvidence.inspect(f, signal()); if (r) records.push(r); }
      const report = { status: outcomes.every(o => o.status === "durable") ? "durable" : "review", outcomes, records,
        gets, puts, downloads, browserExports, models: 0, ocrCalls: 0, productCollected: false, temporal: false, reviewsRepository: "isolated-local" };
      await writeFile(join(root, `${mode}-report.json`), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ status: report.status, outcomes: outcomes.map(o => ({ status: o.status, code: "code" in o ? o.code : null })),
        files: records.map(r => ({ mediaType: r.file.mediaType, byteSize: r.file.byteSize, dimensions: r.dimensions })), gets, puts, downloads, browserExports }));
    }
  } finally { r2.close(); }
}
main().catch(e => { const raw = e?.code ?? e?.message; console.error(JSON.stringify({ status: "LIVE_FILES_UNRESOLVED", code: typeof raw === "string" && /^[A-Z_.]+$/.test(raw) ? raw : "REDACTED" })); process.exitCode = 1; });
