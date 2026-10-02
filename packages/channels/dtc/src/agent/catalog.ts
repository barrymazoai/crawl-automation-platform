import { z } from "zod";
import type { BrowserScanRequest } from "@crawl-automation/channels-core";
import { dtcBrandSource } from "../brand-source.js";
import { catalogUrl, dtcProductAddress, siteForBrandUrl } from "../address.js";
import { assertDtcBrandVerified, dtcBrandEvidence } from "../brand-evidence.js";
import type { DtcSitePolicy } from "../site-policy.js";
import type { DtcBrandScanResult, DtcListingPage } from "../brand-scan.js";
import { dtcDocument } from "../product.js";
import { captureFile, type CaptureFile } from "./archive.js";
import type { DtcCaptureAgent } from "./runner.js";
import { dtcAgentErrors } from "./errors.js";

const Page = z.object({
  url: z.url(),
  htmlPath: z.string(),
  screenshotPath: z.string(),
  entries: z
    .array(
      z.object({
        url: z.url(),
        title: z.string().min(1),
        brand: z.string().nullable(),
      }),
    )
    .max(5000),
});
const Catalog = z.object({
  pages: z.array(Page).min(1).max(500),
  complete: z.boolean(),
  termination: z.object({
    exhausted: z.boolean(),
    reason: z.string().min(1),
    method: z.string().min(1),
    evidence: z.array(z.string()).min(1),
    zeroGrowthRounds: z.number().int().nonnegative(),
    oracle: z.object({
      expected: z.number().int().nonnegative().nullable(),
      observed: z.number().int().nonnegative(),
      comparable: z.boolean(),
    }),
  }),
});

export class DtcAgentBrandScan {
  constructor(
    private readonly deps: {
      agent: Pick<DtcCaptureAgent, "capture">;
      sites: readonly DtcSitePolicy[];
    },
  ) {}

  async scan(request: BrowserScanRequest, signal: AbortSignal): Promise<DtcBrandScanResult> {
    await request.checkpoint?.();
    const site = siteForBrandUrl(request.sourceUrl, this.deps.sites);
    const source = dtcBrandSource(request.sourceUrl, [site]);
    const saved = await this.deps.agent.capture(
      {
        operationId: `catalog-${request.scanId}`,
        url: request.sourceUrl,
        mode: "catalog",
        scope: { source, maxPages: 100, maxProducts: 10000 },
      },
      signal,
    );
    await request.checkpoint?.();
    const catalog = Catalog.parse(
      JSON.parse((await captureFile(saved.root, "catalog.json")).toString()),
    );
    const pages: DtcListingPage[] = [];
    const seen = new Set<string>();
    for (const page of catalog.pages) {
      catalogUrl(page.url, site, request.sourceUrl);
      await verifyCatalogPage(page, { ...saved, site });
      const products = page.entries
        .map((entry) => listedProduct(entry, { site, source }))
        .filter((product) => firstSeen(seen, product.listingId));
      pages.push({ products, cards: products.length, nextPage: null, statedTotal: null });
    }
    verifyTermination(catalog, seen.size, saved.files);
    return {
      sourceUrl: request.sourceUrl,
      source,
      pages,
      complete: catalog.complete,
      soldHere: true,
      archiveKeys: [saved.manifestKey],
      stopped: catalog.complete ? "end" : "page_limit",
    };
  }
}

function firstSeen(seen: Set<string>, id: string) {
  if (seen.has(id)) {
    return false;
  }
  seen.add(id);
  return true;
}

function listedProduct(
  entry: z.infer<typeof Page>["entries"][number],
  scope: {
    site: DtcSitePolicy;
    source: ReturnType<typeof dtcBrandSource>;
  },
) {
  const brandEvidence = dtcBrandEvidence(scope.site, entry.brand, scope.source);
  assertDtcBrandVerified(brandEvidence);
  return {
    ...dtcProductAddress(entry.url, [scope.site]),
    title: entry.title,
    kind: "product" as const,
    brand: scope.source.brand,
    seller: scope.site.siteKey,
    brandBasis: entry.brand ? ("page" as const) : ("source" as const),
    brandEvidence,
  };
}

async function verifyCatalogPage(
  page: z.infer<typeof Page>,
  saved: { root: string; files: CaptureFile[]; site: DtcSitePolicy },
) {
  if (
    !saved.files.some((file) => file.path === page.screenshotPath && file.mediaType === "image/png")
  ) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE");
  }
  const html = await captureFile(saved.root, page.htmlPath);
  const document = dtcDocument(html.toString());
  const observed = new Set(
    [...document.querySelectorAll("a[href]")].map((anchor) => {
      const href = anchor.getAttribute("href");
      try {
        return href
          ? dtcProductAddress(new URL(href, page.url).href, [saved.site]).listingId
          : null;
      } catch {
        return null;
      }
    }),
  );
  if (
    page.entries.some(
      (entry) => !observed.has(dtcProductAddress(entry.url, [saved.site]).listingId),
    )
  ) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE", {
      details: { reason: "catalog_product_not_observed" },
    });
  }
}

function verifyTermination(catalog: z.infer<typeof Catalog>, count: number, files: CaptureFile[]) {
  const { termination } = catalog;
  const oracle = termination.oracle;
  const evidence = new Set(files.map((file) => file.path));
  const consistent = !oracle.comparable || oracle.expected === count;
  if (
    oracle.observed !== count ||
    termination.evidence.some((path) => !evidence.has(path)) ||
    (catalog.complete &&
      (!termination.exhausted || termination.zeroGrowthRounds < 1 || !consistent))
  ) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE", {
      details: { reason: "catalog_completion_unverified" },
    });
  }
}
