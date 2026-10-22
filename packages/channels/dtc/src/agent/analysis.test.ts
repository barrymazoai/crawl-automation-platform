import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SiteAnalysisSchema } from "@crawl-automation/v3-contracts";
import { afterEach, expect, it, vi } from "vitest";
import { analyzeWithDtcAgent } from "./analysis.js";
import type { DtcCaptureAgent } from "./runner.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const input = SiteAnalysisSchema.parse({
  analysisId: "00000000-0000-4000-8000-000000000001",
  url: "https://www.dherbs.com/",
  state: "running",
  brands: [],
  archiveKeys: [],
  reasons: [],
  limits: {},
});

async function captured(analysis: unknown, reachable: boolean) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dtc-analysis-custom-")));
  roots.push(root);
  const pages = reachable
    ? [
        { url: input.url, htmlPath: "home.html", screenshotPath: "home.png" },
        {
          url: "https://www.dherbs.com/store/",
          htmlPath: "catalog.html",
          screenshotPath: "catalog.png",
        },
        {
          url: "https://www.dherbs.com/featured/full-body-cleanse/",
          htmlPath: "product.html",
          screenshotPath: "product.png",
        },
      ]
    : [];
  await writeFile(join(root, "analysis.json"), JSON.stringify(analysis));
  await writeFile(join(root, "evidence-pages.json"), JSON.stringify(pages));
  await writeFile(
    join(root, "analysis-verification.json"),
    JSON.stringify({
      method: "Observed the store catalog and one real product",
      surface: "live_site",
      evidence: ["product.png"],
      verifier: "codex",
      limitsReached: false,
    }),
  );
  const files = pages.flatMap((page) => [
    { path: page.htmlPath, mediaType: "text/html" },
    { path: page.screenshotPath, mediaType: "image/png" },
  ]);
  for (const file of files) {
    await writeFile(
      join(root, file.path),
      file.mediaType === "text/html" ? "<main>Product</main>" : "png",
    );
  }
  const agent = {
    capture: vi.fn(async () => ({
      root,
      files,
      manifestKey: "v3/dtc-agent/analysis/capture.json",
    })),
  } as unknown as Pick<DtcCaptureAgent, "capture">;
  return agent;
}

it("completes a verified custom store with only an observed product count", async () => {
  const brand = {
    name: "Dherbs",
    domain: "www.dherbs.com",
    platform: "custom",
    catalogUrl: "https://www.dherbs.com/store/",
    productCount: 27,
    countExact: false,
    wholeCatalog: false,
    discoveredFrom: { page: input.url, link: "https://www.dherbs.com/store/" },
    status: "verified",
    reason: null,
  };
  const agent = await captured(
    { state: "completed", brands: [brand], archiveKeys: [], reasons: [] },
    true,
  );
  const result = await analyzeWithDtcAgent(agent, input, new AbortController().signal);
  expect(result).toMatchObject({ state: "completed", brands: [brand] });
});

it("keeps an unreachable site in needs-review without page evidence", async () => {
  const agent = await captured(
    { state: "needs-review", brands: [], reasons: ["TLS blocked"] },
    false,
  );
  const result = await analyzeWithDtcAgent(agent, input, new AbortController().signal);
  expect(result).toMatchObject({ state: "needs-review", brands: [], reasons: ["TLS blocked"] });
});
