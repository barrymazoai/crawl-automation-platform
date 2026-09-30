import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { CodexProcessRunner } from "@crawl-automation/runtime";
import {
  buildCompanyIdentityPrompt,
  companyIdentityVerdictSchema,
  companySearchQueries,
  exactIdentityVerdict,
  normalizeCompanyBrand,
  parseGncSearchHtml,
  type CompanyIdentityInput,
  type CompanyIdentityVerdict,
  type GncSearchEvidence,
} from "../src/gnc/company-identity.js";
import { GncCompanyIdentityState } from "../src/gnc/company-identity-state.js";

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const cli = z.object({
  stateFile: z.string().min(1),
  outputDirectory: z.string().min(1),
  matchedCompaniesFile: z.string().min(1),
  requestDelayMs: z.coerce.number().int().min(1_000).max(30_000).default(3_000),
  idleMs: z.coerce.number().int().min(5_000).max(300_000).default(30_000),
  maxAttempts: z.coerce.number().int().min(1).max(10).default(3),
}).parse({
  stateFile: flag("--state") ?? path.resolve("reports", "gnc-company-identity", "state.sqlite"),
  outputDirectory: flag("--output-dir") ?? path.resolve("reports", "gnc-company-identity"),
  matchedCompaniesFile: flag("--matched-companies") ?? "/tmp/gnc-company-matches.json",
  requestDelayMs: flag("--request-delay-ms") ?? 3_000,
  idleMs: flag("--idle-ms") ?? 30_000,
  maxAttempts: flag("--max-attempts") ?? 3,
});

if (!process.env.PRODUCT_DATABASE_URL) throw new Error("PRODUCT_DATABASE_URL 未配置");

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = path.resolve(backendDirectory, "../..");
const statusFile = path.join(cli.outputDirectory, "queue-status.json");
const pidFile = path.join(cli.outputDirectory, "agent.pid");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { stopping = true; });

await fs.mkdir(cli.outputDirectory, { recursive: true });
const oldPid = Number(await fs.readFile(pidFile, "utf8").catch(() => ""));
if (Number.isInteger(oldPid) && oldPid > 0) {
  try { process.kill(oldPid, 0); throw new Error(`GNC company identity agent 已运行，PID=${oldPid}`); }
  catch (error) { if (error instanceof Error && error.message.includes("已运行")) throw error; }
}
await fs.writeFile(pidFile, `${process.pid}\n`);

async function loadCompanies() {
  const matched = JSON.parse(await fs.readFile(cli.matchedCompaniesFile, "utf8")) as Array<{ companyId?: string }>;
  const excluded = new Set(matched.map((item) => item.companyId).filter((value): value is string => typeof value === "string"));
  if (excluded.size === 0) throw new Error(`已入队公司清单为空，拒绝重复扫描：${cli.matchedCompaniesFile}`);
  const pool = new pg.Pool({ connectionString: process.env.PRODUCT_DATABASE_URL, max: 1 });
  try {
    const rows = (await pool.query("select id,name,canonical_name,website from company order by id")).rows as Array<{
      id: string; name: string; canonical_name: string | null; website: string | null;
    }>;
    return rows.filter((row) => !excluded.has(row.id)).map((row): CompanyIdentityInput => ({
      companyId: row.id,
      companyName: row.name,
      canonicalName: row.canonical_name,
      website: row.website,
    }));
  } finally { await pool.end(); }
}

async function writeStatus(state: GncCompanyIdentityState, activeCompanyId: string | null) {
  const value = {
    mode: "gnc_company_identity_discovery",
    concurrency: 1,
    databaseWrites: false,
    crawlJobsCreated: false,
    generatedAt: new Date().toISOString(),
    activeCompanyId,
    counts: state.summary(),
    recent: state.listRecent(20),
  };
  const temporary = `${statusFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, statusFile);
}

async function searchGnc(query: string): Promise<GncSearchEvidence> {
  const searchUrl = new URL("https://www.gnc.com/search");
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("start", "0");
  searchUrl.searchParams.set("sz", "30");
  const response = await fetch(searchUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(45_000),
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
      accept: "text/html,application/xhtml+xml",
    },
  });
  const html = await response.text();
  const evidence = parseGncSearchHtml(html, query, response.url || searchUrl.toString());
  if (response.status === 406 || response.status === 429 || evidence.denied) {
    throw new Error(`gnc_access_challenge:${response.status}`);
  }
  if (!response.ok) throw new Error(`gnc_search_http_${response.status}`);
  if (!evidence.returnedQuery || normalizeCompanyBrand(evidence.returnedQuery) !== normalizeCompanyBrand(query)) {
    throw new Error("gnc_search_query_mismatch");
  }
  if (evidence.resultsNumber === 0 && evidence.products.length === 0 && !evidence.explicitNoResults) {
    throw new Error("gnc_search_zero_without_no_results_evidence");
  }
  if (evidence.resultsNumber == null && evidence.products.length === 0) throw new Error("gnc_search_unrecognized_page");
  return evidence;
}

function mergeEvidence(items: GncSearchEvidence[]) {
  const products = new Map<string, GncSearchEvidence["products"][number]>();
  const brandPages = new Set<string>();
  for (const item of items) {
    for (const product of item.products) products.set(`${product.sku}:${product.url}`, product);
    item.brandPageUrls.forEach((url) => brandPages.add(url));
  }
  return { products: [...products.values()], brandPageUrls: [...brandPages] };
}

delete process.env.CODEX_API_KEY;
const codex = new CodexProcessRunner({
  executable: process.env.CODEX_EXECUTABLE ?? "codex",
  model: process.env.CODEX_MODEL ?? "gpt-5.6-luna",
  reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "medium",
  unattendedFullAccess: false,
});

async function resolveWithAgent(company: CompanyIdentityInput, evidence: GncSearchEvidence[]) {
  const companyDirectory = path.join(cli.outputDirectory, "evidence", company.companyId);
  await fs.mkdir(companyDirectory, { recursive: true });
  const prompt = buildCompanyIdentityPrompt(company, evidence);
  await fs.writeFile(path.join(companyDirectory, "input.json"), `${JSON.stringify({
    company: { name: company.companyName, canonicalName: company.canonicalName, website: company.website },
    evidence,
  }, null, 2)}\n`);
  const result = await codex.run({
    prompt,
    cwd: repositoryDirectory,
    addDirectories: [companyDirectory],
    schemaPath: path.join(backendDirectory, "model-payload.schema.json"),
    outputPath: path.join(companyDirectory, "verdict.result.json"),
    eventLogPath: path.join(companyDirectory, "verdict.events.jsonl"),
    signal: AbortSignal.timeout(900_000),
  });
  if (!result || typeof result !== "object" || !("payload" in result) || typeof result.payload !== "string") {
    throw new Error("identity_agent_missing_payload");
  }
  const parsed = companyIdentityVerdictSchema.parse(JSON.parse(result.payload));
  const brands = new Set(mergeEvidence(evidence).products.map((product) => normalizeCompanyBrand(product.brand)));
  if (parsed.gncBrandName && !brands.has(normalizeCompanyBrand(parsed.gncBrandName))) {
    return { ...parsed, status: "review" as const, relationship: "unverified" as const, confidence: Math.min(parsed.confidence, 0.5), reasons: [...parsed.reasons, "verdict_brand_not_in_gnc_structured_evidence"] };
  }
  if (parsed.status === "confirmed" && (parsed.confidence < 0.9 || parsed.evidence.length === 0)) {
    return { ...parsed, status: "review" as const, confidence: Math.min(parsed.confidence, 0.89), reasons: [...parsed.reasons, "confirmation_threshold_not_met"] };
  }
  return parsed;
}

async function processCompany(company: CompanyIdentityInput) {
  const evidence: GncSearchEvidence[] = [];
  for (const query of companySearchQueries(company)) {
    const result = await searchGnc(query);
    evidence.push(result);
    if (result.products.length > 0) break;
    if (!stopping) await sleep(cli.requestDelayMs);
  }
  const merged = mergeEvidence(evidence);
  if (merged.products.length === 0) {
    return { evidence, verdict: {
      status: "no_match",
      gncBrandName: null,
      gncBrandPageUrl: null,
      relationship: "unverified",
      confidence: 1,
      evidence: evidence.map((item) => `GNC search ${item.searchUrl}: ${item.resultsNumber ?? 0} product results`),
      reasons: ["no_gnc_product_results"],
    } satisfies CompanyIdentityVerdict };
  }
  const exact = exactIdentityVerdict(company, evidence);
  if (exact) return { evidence, verdict: exact };
  return { evidence, verdict: await resolveWithAgent(company, evidence) };
}

const state = new GncCompanyIdentityState(cli.stateFile);
try {
  state.seed(await loadCompanies());
  state.recoverInterrupted();
  await writeStatus(state, null);
  while (!stopping) {
    const company = state.claim();
    if (!company) {
      await writeStatus(state, null);
      const next = state.nextAvailableAt();
      const wait = next ? Math.max(cli.idleMs, new Date(next).getTime() - Date.now()) : cli.idleMs;
      await sleep(Math.min(wait, cli.idleMs));
      continue;
    }
    await writeStatus(state, company.companyId);
    try {
      const { evidence, verdict } = await processCompany(company);
      state.record(company.companyId, verdict.status, evidence, verdict);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const challenge = message.startsWith("gnc_access_challenge:");
      state.recordError(company.companyId, message, challenge ? 300_000 : 60_000, cli.maxAttempts);
    }
    await writeStatus(state, null);
    if (!stopping) await sleep(cli.requestDelayMs);
  }
} finally {
  await writeStatus(state, null).catch(() => undefined);
  state.close();
  await fs.rm(pidFile, { force: true });
}
