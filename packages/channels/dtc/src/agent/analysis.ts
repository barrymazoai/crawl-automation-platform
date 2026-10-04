import { z } from "zod";
import { SiteAnalysisResultSchema, type SiteAnalysis } from "@crawl-automation/v3-contracts";
import type { DtcCaptureAgent } from "./runner.js";
import { captureFile, type CaptureFile } from "./archive.js";
import { dtcAgentErrors } from "./errors.js";

const Page = z.object({ url: z.url(), htmlPath: z.string(), screenshotPath: z.string() });
const Pages = z
  .union([z.array(Page), z.record(z.string(), z.array(Page))])
  .transform((pages) => {
    const entries = Array.isArray(pages) ? pages : Object.values(pages).flat();
    return [...new Map(entries.map((page) => [JSON.stringify(page), page])).values()];
  })
  .pipe(z.array(Page).min(1));
const Verification = z.object({
  method: z.string().min(1),
  surface: z.literal("live_site"),
  evidence: z.array(z.string()).min(1),
  verifier: z.literal("codex"),
  limitsReached: z.boolean(),
});

export async function analyzeWithDtcAgent(
  agent: Pick<DtcCaptureAgent, "capture">,
  input: SiteAnalysis,
  signal: AbortSignal,
) {
  const saved = await agent.capture(
    {
      operationId: `analysis-${input.analysisId}`,
      mode: "analysis",
      url: input.url,
      scope: input.limits,
    },
    signal,
  );
  const result = SiteAnalysisResultSchema.parse(
    JSON.parse((await captureFile(saved.root, "analysis.json")).toString()),
  );
  const pages = Pages.parse(
    JSON.parse((await captureFile(saved.root, "evidence-pages.json")).toString()),
  );
  const verification = Verification.parse(
    JSON.parse((await captureFile(saved.root, "analysis-verification.json")).toString()),
  );
  verifyEvidence(pages, saved.files);
  verifyAnalysis({ result, pages, verification, files: saved.files }, input);
  const incomplete =
    verification.limitsReached ||
    !result.brands.length ||
    result.brands.some((brand) => brand.status !== "verified");
  return {
    ...result,
    state: incomplete ? ("needs-review" as const) : result.state,
    archiveKeys: [saved.manifestKey],
  };
}

function verifyAnalysis(
  at: {
    result: z.infer<typeof SiteAnalysisResultSchema>;
    pages: z.infer<typeof Pages>;
    verification: z.infer<typeof Verification>;
    files: CaptureFile[];
  },
  input: SiteAnalysis,
) {
  const { result, pages, verification } = at;
  const urls = new Set(pages.map((page) => page.url));
  const exceeds =
    pages.length > input.limits.maxPages ||
    result.brands.length > input.limits.maxBrands ||
    new Set(pages.map((page) => new URL(page.url).hostname)).size > input.limits.maxDomains;
  if (
    exceeds ||
    verification.evidence.some((path) => !at.files.some((file) => file.path === path))
  ) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
  }
  for (const brand of result.brands) {
    verifyBrand(brand, urls);
    brand.countExact = false;
    brand.wholeCatalog = false;
  }
}

function verifyBrand(
  brand: z.infer<typeof SiteAnalysisResultSchema>["brands"][number],
  urls: Set<string>,
) {
  if (brand.status !== "verified") {
    return;
  }
  const hostname = brand.catalogUrl ? new URL(brand.catalogUrl).hostname : "";
  const declared = brand.domain.trim().toLowerCase();
  const sameHost = hostname.replace(/^www\./, "") === declared.replace(/^www\./, "");
  if (
    !brand.catalogUrl ||
    !urls.has(brand.catalogUrl) ||
    !sameHost ||
    typeof brand.discoveredFrom === "string" ||
    !urls.has(brand.discoveredFrom.page)
  ) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
  }
  brand.domain = hostname;
}

function verifyEvidence(pages: z.infer<typeof Pages>, files: CaptureFile[]) {
  for (const page of pages) {
    const html = files.find((file) => file.path === page.htmlPath);
    const screenshot = files.find((file) => file.path === page.screenshotPath);
    if (html?.mediaType !== "text/html" || screenshot?.mediaType !== "image/png") {
      throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
    }
  }
}
