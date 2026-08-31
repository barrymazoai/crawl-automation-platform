import fs from "node:fs/promises";
import path from "node:path";
import { startChromeLane, type ChromeLane } from "@crawl-automation/runtime";
import { z } from "zod";
import {
  captureProducts,
  discoverProductUrls,
  GncAccessChallengeError,
} from "../src/gnc/capture.js";
import type { BrowserTraffic } from "../src/amazon/browser.js";

function flag(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const cli = z.object({
  companiesFile: z.string().min(1),
  outputDirectory: z.string().min(1),
  profileRoot: z.string().min(1),
  startIndex: z.coerce.number().int().min(1).default(1),
  maxCompanies: z.coerce.number().int().min(1).max(10_000).default(10_000),
  maxProductsPerCompany: z.coerce.number().int().min(1).max(5_000).default(5_000),
  companyDelayMs: z.coerce.number().int().min(0).max(60_000).default(3_000),
  recoveryIntervalMs: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),
  maxRecoveryProbes: z.coerce.number().int().min(1).max(1_000).default(72),
}).parse({
  companiesFile: flag("--companies") ?? path.resolve("reports", "gnc-company-matches.json"),
  outputDirectory: flag("--output-dir") ?? path.resolve("reports", `gnc-px-cooldown-${Date.now()}`),
  profileRoot: flag("--profile-root") ?? path.resolve("state", "chrome-gnc-px-cooldown"),
  startIndex: flag("--start-index") ?? 1,
  maxCompanies: flag("--max-companies") ?? 10_000,
  maxProductsPerCompany: flag("--max-products-per-company") ?? 5_000,
  companyDelayMs: flag("--company-delay-ms") ?? 3_000,
  recoveryIntervalMs: flag("--recovery-interval-ms") ?? 300_000,
  maxRecoveryProbes: flag("--max-recovery-probes") ?? 72,
});

const companies = z.array(z.object({
  name: z.string().min(1),
  url: z.url(),
  companyId: z.string().optional(),
  companyName: z.string().optional(),
})).parse(JSON.parse(await fs.readFile(cli.companiesFile, "utf8")))
  .slice(cli.startIndex - 1, cli.startIndex - 1 + cli.maxCompanies);

type Phase = "loading" | "cooldown" | "recovered" | "completed_without_block" | "recovery_timeout" | "stopped" | "failed";
type NavigationMetric = {
  at: string;
  companyIndex: number;
  companyName: string;
  kind: "catalog" | "product";
  url: string;
  status: number;
  denied: boolean;
  traffic: BrowserTraffic;
};
type BlockMetric = {
  at: string;
  companyIndex: number;
  companyName: string;
  url: string;
  status: number;
  message: string;
  elapsedFromStartMs: number;
  successfulProductPages: number;
  successfulCatalogPages: number;
};
type RecoveryAttempt = {
  attempt: number;
  at: string;
  elapsedFromBlockMs: number;
  status: "blocked" | "recovered" | "error";
  httpStatus: number | null;
  denied: boolean | null;
  message: string | null;
};

const startedAt = new Date().toISOString();
const startedAtMs = Date.parse(startedAt);
const reportFile = path.join(cli.outputDirectory, "cooldown-report.json");
const eventFile = path.join(cli.outputDirectory, "events.jsonl");
const pidFile = path.join(cli.outputDirectory, "probe.pid");
const navigations: NavigationMetric[] = [];
const recoveryAttempts: RecoveryAttempt[] = [];
let phase: Phase = "loading";
let block: BlockMetric | null = null;
let recoveredAt: string | null = null;
let chromeRestarts = 0;
let fatalError: string | null = null;
let chrome: ChromeLane | null = null;
const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => controller.abort());
}

function isSuccessfulNavigation(item: NavigationMetric) {
  return !item.denied && item.status >= 200 && item.status < 400;
}

function successfulCount(kind: NavigationMetric["kind"]) {
  return navigations.filter((item) => item.kind === kind && isSuccessfulNavigation(item)).length;
}

function buildReport() {
  const lastFailedProbe = [...recoveryAttempts].reverse().find((item) => item.status === "blocked") ?? null;
  const firstSuccessfulProbe = recoveryAttempts.find((item) => item.status === "recovered") ?? null;
  return {
    mode: "gnc_px_cooldown_probe",
    headed: true,
    sameIp: true,
    samePersistentProfile: true,
    writesProductDatabase: false,
    downloadsLabelPdf: false,
    usesCodex: false,
    usesOcr: false,
    phase,
    startedAt,
    updatedAt: new Date().toISOString(),
    configuration: {
      startIndex: cli.startIndex,
      requestedCompanies: companies.length,
      maxProductsPerCompany: cli.maxProductsPerCompany,
      companyDelayMs: cli.companyDelayMs,
      recoveryIntervalMs: cli.recoveryIntervalMs,
      maxRecoveryProbes: cli.maxRecoveryProbes,
      profileRoot: cli.profileRoot,
    },
    load: {
      successfulProductPages: successfulCount("product"),
      successfulCatalogPages: successfulCount("catalog"),
      navigationAttempts: navigations.length,
      block,
    },
    recovery: {
      attempts: recoveryAttempts,
      recoveredAt,
      observedCooldownMs: block && recoveredAt ? Date.parse(recoveredAt) - Date.parse(block.at) : null,
      precisionMs: cli.recoveryIntervalMs,
      lastConfirmedBlockedAfterMs: lastFailedProbe?.elapsedFromBlockMs ?? null,
      firstConfirmedRecoveredAfterMs: firstSuccessfulProbe?.elapsedFromBlockMs ?? null,
    },
    chromeRestarts,
    fatalError,
    navigations,
  };
}

async function saveReport() {
  await fs.mkdir(cli.outputDirectory, { recursive: true });
  const temporary = `${reportFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(buildReport(), null, 2)}\n`);
  await fs.rename(temporary, reportFile);
}

async function emit(type: string, value: Record<string, unknown>) {
  const event = { at: new Date().toISOString(), type, ...value };
  await fs.appendFile(eventFile, `${JSON.stringify(event)}\n`);
  console.log(JSON.stringify(event));
}

async function sleep(ms: number) {
  if (controller.signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", done);
      resolve();
    }
    controller.signal.addEventListener("abort", done, { once: true });
  });
}

async function startChrome() {
  chrome = await startChromeLane({ id: 1, profileRoot: cli.profileRoot, headless: false });
  process.env.CHROME_CDP_URL = chrome.cdpUrl;
}

async function ensureChrome() {
  if (chrome && await chrome.health()) return;
  if (chrome) await chrome.close().catch(() => undefined);
  chromeRestarts += 1;
  await startChrome();
  await emit("chrome_restarted", { chromeRestarts });
}

function challengeFrom(caught: unknown) {
  const message = caught instanceof Error ? caught.message : String(caught);
  return caught instanceof GncAccessChallengeError || /access.challenge|perimeterx|captcha|HTTP 307/i.test(message);
}

await fs.mkdir(cli.outputDirectory, { recursive: true });
await fs.writeFile(pidFile, `${process.pid}\n`);
await emit("started", {
  headed: true,
  profileRoot: cli.profileRoot,
  recoveryIntervalMs: cli.recoveryIntervalMs,
  maxRecoveryProbes: cli.maxRecoveryProbes,
});

try {
  await startChrome();
  for (let offset = 0; offset < companies.length && !controller.signal.aborted && !block; offset += 1) {
    const company = companies[offset]!;
    const companyIndex = cli.startIndex + offset;
    const companyName = company.companyName ?? company.name;
    const onNavigation = async (event: Omit<NavigationMetric, "at" | "companyIndex" | "companyName">) => {
      const metric = { at: new Date().toISOString(), companyIndex, companyName, ...event };
      navigations.push(metric);
      await saveReport();
      await emit("load_navigation", {
        companyIndex,
        companyName,
        kind: metric.kind,
        url: metric.url,
        status: metric.status,
        denied: metric.denied,
        successfulProductPages: successfulCount("product"),
        successfulCatalogPages: successfulCount("catalog"),
      });
    };
    try {
      await ensureChrome();
      const jobDirectory = path.join(cli.outputDirectory, "load", String(companyIndex).padStart(4, "0"));
      const options = {
        url: company.url,
        jobDirectory,
        maxItems: cli.maxProductsPerCompany,
        signal: controller.signal,
        onNavigation,
      };
      const discovery = await discoverProductUrls(options);
      await captureProducts(options, discovery.urls);
      await emit("company_completed", { companyIndex, companyName, discoveredProducts: discovery.urls.length });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (!challengeFrom(caught)) {
        await emit("company_error", { companyIndex, companyName, message });
        continue;
      }
      const last = navigations.at(-1);
      block = {
        at: last?.at ?? new Date().toISOString(),
        companyIndex,
        companyName,
        url: last?.url ?? company.url,
        status: last?.status ?? 0,
        message,
        elapsedFromStartMs: Date.now() - startedAtMs,
        successfulProductPages: successfulCount("product"),
        successfulCatalogPages: successfulCount("catalog"),
      };
      phase = "cooldown";
      await saveReport();
      await emit("blocked", { ...block });
      break;
    }
    if (cli.companyDelayMs > 0) await sleep(cli.companyDelayMs);
  }

  if (!block && !controller.signal.aborted) {
    phase = "completed_without_block";
    await emit("completed_without_block", {
      successfulProductPages: successfulCount("product"),
      successfulCatalogPages: successfulCount("catalog"),
    });
  }

  for (let attempt = 1; block && attempt <= cli.maxRecoveryProbes && !controller.signal.aborted; attempt += 1) {
    await sleep(cli.recoveryIntervalMs);
    if (controller.signal.aborted) break;
    const at = new Date().toISOString();
    let lastNavigation: { status: number; denied: boolean } | null = null;
    let status: RecoveryAttempt["status"] = "error";
    let message: string | null = null;
    try {
      await ensureChrome();
      const options = {
        url: block.url,
        jobDirectory: path.join(cli.outputDirectory, "recovery", String(attempt).padStart(3, "0")),
        maxItems: 1,
        signal: controller.signal,
        onNavigation: (event: { status: number; denied: boolean }) => { lastNavigation = event; },
      };
      await captureProducts(options, [block.url]);
      status = "recovered";
    } catch (caught) {
      message = caught instanceof Error ? caught.message : String(caught);
      status = challengeFrom(caught) ? "blocked" : "error";
    }
    const result: RecoveryAttempt = {
      attempt,
      at,
      elapsedFromBlockMs: Date.parse(at) - Date.parse(block.at),
      status,
      httpStatus: lastNavigation?.status ?? null,
      denied: lastNavigation?.denied ?? null,
      message,
    };
    recoveryAttempts.push(result);
    await emit("recovery_probe", { ...result });
    if (status === "recovered") {
      recoveredAt = at;
      phase = "recovered";
      break;
    }
    await saveReport();
  }

  if (block && !recoveredAt && !controller.signal.aborted && recoveryAttempts.length >= cli.maxRecoveryProbes) {
    phase = "recovery_timeout";
  }
  if (controller.signal.aborted) phase = "stopped";
} catch (caught) {
  fatalError = caught instanceof Error ? caught.message : String(caught);
  phase = controller.signal.aborted ? "stopped" : "failed";
  await emit("fatal_error", { message: fatalError });
  if (!controller.signal.aborted) process.exitCode = 1;
} finally {
  await saveReport().catch(() => undefined);
  if (chrome) await chrome.close().catch(() => undefined);
  await fs.rm(pidFile, { force: true }).catch(() => undefined);
}

await emit("finished", { phase, reportFile });
