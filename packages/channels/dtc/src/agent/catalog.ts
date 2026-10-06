import { z } from "zod";
import type { BrowserScanRequest } from "@crawl-automation/channels-core";
import { dtcBrandSource } from "../brand-source.js";
import { catalogUrl, dtcProductAddress, siteForBrandUrl, siteForUrl } from "../address.js";
import { assertDtcBrandVerified, dtcBrandEvidence } from "../brand-evidence.js";
import type { DtcSitePolicy } from "../site-policy.js";
import type { DtcBrandScanResult, DtcListingPage } from "../brand-scan.js";
import { dtcDocument } from "../product.js";
import { captureFile, type CaptureFile } from "./archive.js";
import type { DtcCaptureAgent } from "./runner.js";
import { dtcAgentErrors } from "./errors.js";
import { verifyCatalogDiscovery } from "./catalog-discovery.js";

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
    proof: z.enum(["enumeration", "shopify"]).default("enumeration"),
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
      agent: Pick<DtcCaptureAgent, "capture"> &
        Partial<Pick<DtcCaptureAgent, "acceptCatalogMethod">>;
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
        scope: { source, siteKind: site.kind, maxPages: 100, maxProducts: 10000 },
      },
      signal,
    );
    await request.checkpoint?.();
    const catalog = await readCatalog(saved);
    const pages: DtcListingPage[] = [];
    const seen = new Set<string>();
    for (const page of catalog.pages) {
      verifyCatalogScope(page.url, site, request.sourceUrl);
      await verifyCatalogPage(page, { ...saved, site });
      const products = page.entries
        .map((entry) => listedProduct(entry, { site, source }))
        .filter((product) => !seen.has(product.listingId) && seen.add(product.listingId));
      pages.push({ products, cards: products.length, nextPage: null, statedTotal: null });
    }
    const completionScope = { listingIds: seen, site, sourceUrl: request.sourceUrl };
    await verifyCompletion(catalog, saved, completionScope);
    await this.acceptMethod(catalog.complete, saved, request.sourceUrl);
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
  private async acceptMethod(
    complete: boolean,
    saved: Awaited<ReturnType<DtcCaptureAgent["capture"]>>,
    sourceUrl: string,
  ) {
    if (complete) {
      await this.deps.agent.acceptCatalogMethod?.(saved, sourceUrl);
    }
  }
}

/** A catalog the model doubted keeps its products but never proves the brand's full listing. */
async function readCatalog(saved: Awaited<ReturnType<DtcCaptureAgent["capture"]>>) {
  const read = Catalog.parse(
    JSON.parse((await captureFile(saved.root, "catalog.json")).toString()),
  );
  return saved.agentWarning ? { ...read, complete: false } : read;
}

async function verifyCompletion(
  catalog: z.infer<typeof Catalog>,
  saved: Awaited<ReturnType<DtcCaptureAgent["capture"]>>,
  scope: { listingIds: Set<string>; site: DtcSitePolicy; sourceUrl: string },
) {
  verifyTermination(catalog, scope.listingIds.size, saved.files);
  await verifyCatalogDiscovery(saved, {
    complete: catalog.complete,
    zeroGrowthRounds: catalog.termination.zeroGrowthRounds,
    completionProof: catalog.termination.proof,
    pageUrls: catalog.pages.map((page) => page.url),
    ...scope,
  });
}

function verifyCatalogScope(url: string, site: DtcSitePolicy, source: string) {
  // A single-brand store may require several observed category seeds for its complete catalog.
  if (site.kind === "single-brand") {
    siteForUrl(url, [site]);
  } else {
    catalogUrl(url, site, source);
  }
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
      (!termination.exhausted ||
        (termination.proof === "enumeration" && termination.zeroGrowthRounds < 1) ||
        !consistent))
  ) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE", {
      details: { reason: "catalog_completion_unverified" },
    });
  }
}
