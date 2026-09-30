import fs from "node:fs/promises";
import path from "node:path";
import { startChromeLane } from "@crawl-automation/runtime";
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
}).parse({
  companiesFile: flag("--companies") ?? path.resolve("reports", "gnc-company-matches.json"),
  outputDirectory: flag("--output-dir") ?? path.resolve("reports", `gnc-traffic-probe-${Date.now()}`),
  profileRoot: flag("--profile-root") ?? path.resolve(".automation-state", "chrome-gnc"),
  startIndex: flag("--start-index") ?? 1,
  maxCompanies: flag("--max-companies") ?? 10_000,
  maxProductsPerCompany: flag("--max-products-per-company") ?? 5_000,
  companyDelayMs: flag("--company-delay-ms") ?? 3_000,
});

const companies = z.array(z.object({
  name: z.string().min(1),
  url: z.url(),
  companyId: z.string().optional(),
  companyName: z.string().optional(),
})).parse(JSON.parse(await fs.readFile(cli.companiesFile, "utf8"))).slice(cli.startIndex - 1, cli.startIndex - 1 + cli.maxCompanies);

type NavigationMetric = {
  companyIndex: number;
  companyName: string;
  kind: "catalog" | "product";
  url: string;
  status: number;
  denied: boolean;
  traffic: BrowserTraffic;
};

type CompanyMetric = {
  companyIndex: number;
  companyName: string;
  url: string;
  status: "complete" | "access_challenge" | "failed";
  discoveredProducts: number;
  capturedProducts: number;
  browserBytes: number;
  labelPdfBytes: number;
  requestCount: number;
  failedRequestCount: number;
  error: string | null;
};

const startedAt = new Date().toISOString();
const navigations: NavigationMetric[] = [];
const companyResults: CompanyMetric[] = [];
let labelPdfBytes = 0;
let blockedAt: { companyIndex: number; companyName: string; url: string; message: string } | null = null;
const reportFile = path.join(cli.outputDirectory, "traffic-report.json");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sumBrowserBytes(items: NavigationMetric[]) {
  return items.reduce((sum, item) => sum + item.traffic.encodedBytes, 0);
}

function buildReport() {
  const browserBytes = sumBrowserBytes(navigations);
  const totalBytes = browserBytes + labelPdfBytes;
  const completedCompanies = companyResults.filter((item) => item.status === "complete").length;
  const capturedProducts = companyResults.reduce((sum, item) => sum + item.capturedProducts, 0);
  const catalogBytes = navigations.filter((item) => item.kind === "catalog").reduce((sum, item) => sum + item.traffic.encodedBytes, 0);
  const productPageBytes = navigations.filter((item) => item.kind === "product").reduce((sum, item) => sum + item.traffic.encodedBytes, 0);
  return {
    mode: "gnc_browser_traffic_probe",
    writesProductDatabase: false,
    usesCodex: false,
    usesOcr: false,
    startedAt,
    updatedAt: new Date().toISOString(),
    requestedCompanies: companies.length,
    attemptedCompanies: companyResults.length,
    completedCompanies,
    capturedProducts,
    blockedAt,
    traffic: {
      browserBytes,
      catalogBytes,
      productPageBytes,
      labelPdfBytes,
      totalBytes,
      requestCount: navigations.reduce((sum, item) => sum + item.traffic.requestCount, 0),
      failedRequestCount: navigations.reduce((sum, item) => sum + item.traffic.failedRequestCount, 0),
      averageBytesPerCompletedCompany: completedCompanies ? Math.round(totalBytes / completedCompanies) : null,
      averageBytesPerCapturedProduct: capturedProducts ? Math.round((productPageBytes + labelPdfBytes) / capturedProducts) : null,
    },
    companies: companyResults,
    navigations,
  };
}

async function saveReport() {
  await fs.mkdir(cli.outputDirectory, { recursive: true });
  const temporary = `${reportFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(buildReport(), null, 2)}\n`);
  await fs.rename(temporary, reportFile);
}

async function measureLabelPdf(url: string) {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; SupplySmartGncTrafficProbe/1.0)" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`label_pdf_http_${response.status}`);
  return (await response.arrayBuffer()).byteLength;
}

await fs.mkdir(cli.outputDirectory, { recursive: true });
const chrome = await startChromeLane({ id: 1, profileRoot: cli.profileRoot, headless: false });
process.env.CHROME_CDP_URL = chrome.cdpUrl;
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort());

try {
  for (let index = 0; index < companies.length && !controller.signal.aborted; index += 1) {
    const company = companies[index]!;
    const companyIndex = cli.startIndex + index;
    const firstNavigation = navigations.length;
    let discoveredProducts = 0;
    let capturedProducts = 0;
    let companyLabelBytes = 0;
    const onNavigation = async (event: Omit<NavigationMetric, "companyIndex" | "companyName">) => {
      navigations.push({ companyIndex, companyName: company.companyName ?? company.name, ...event });
      await saveReport();
    };
    let status: CompanyMetric["status"] = "complete";
    let error: string | null = null;
    try {
      const jobDirectory = path.join(cli.outputDirectory, "evidence", String(companyIndex).padStart(4, "0"));
      const discovery = await discoverProductUrls({
        url: company.url,
        jobDirectory,
        maxItems: cli.maxProductsPerCompany,
        signal: controller.signal,
        onNavigation,
      });
      discoveredProducts = discovery.urls.length;
      const capture = await captureProducts({
        url: company.url,
        jobDirectory,
        maxItems: cli.maxProductsPerCompany,
        signal: controller.signal,
        onNavigation,
      }, discovery.urls);
      capturedProducts = capture.products.length;
      for (const pdfUrl of [...new Set(capture.products.map((product) => product.labelPdfUrl).filter((value): value is string => Boolean(value)))]) {
        const bytes = await measureLabelPdf(pdfUrl);
        labelPdfBytes += bytes;
        companyLabelBytes += bytes;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      if (caught instanceof GncAccessChallengeError || /access.challenge|perimeterx|captcha/i.test(error)) {
        status = "access_challenge";
        blockedAt = { companyIndex, companyName: company.companyName ?? company.name, url: company.url, message: error };
      } else status = "failed";
    }
    const ownNavigations = navigations.slice(firstNavigation);
    companyResults.push({
      companyIndex,
      companyName: company.companyName ?? company.name,
      url: company.url,
      status,
      discoveredProducts,
      capturedProducts,
      browserBytes: sumBrowserBytes(ownNavigations),
      labelPdfBytes: companyLabelBytes,
      requestCount: ownNavigations.reduce((sum, item) => sum + item.traffic.requestCount, 0),
      failedRequestCount: ownNavigations.reduce((sum, item) => sum + item.traffic.failedRequestCount, 0),
      error,
    });
    await saveReport();
    console.log(JSON.stringify(companyResults.at(-1)));
    if (status === "access_challenge") break;
    if (cli.companyDelayMs > 0) await sleep(cli.companyDelayMs);
  }
} finally {
  await saveReport().catch(() => undefined);
  await chrome.close();
}

console.log(JSON.stringify({ ...buildReport(), companies: undefined, navigations: undefined, reportFile }, null, 2));
