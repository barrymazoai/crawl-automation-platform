import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { DtcCatalogCoverageSchema } from "@crawl-automation/v3-contracts";
import { verifyDtcCatalogCoverage } from "../../../../../crawl-products/lib/catalog-coverage.mjs";
import { captureFile, type CaptureFile } from "./archive.js";
import { dtcDocument } from "../product.js";
import { dtcAgentErrors } from "./errors.js";

const Evidence = z.object({
  catalogRoot: z.string().min(1).max(500),
  htmlPath: z.string().min(1),
  screenshotPath: z.string().min(1),
});
type Saved = { root: string; files: CaptureFile[] };

/** Reuse the legacy verifier and bind its DOM/responses to this capture's originals. */
export async function verifyShopifyCatalog(
  saved: Saved,
  expected: { sourceUrl: string; productUrls: string[] },
) {
  try {
    const proof = DtcCatalogCoverageSchema.parse(await readJson(saved, "catalog-coverage.json"));
    const evidence = Evidence.parse(await readJson(saved, "catalog-coverage-evidence.json"));
    requireFile(saved, evidence.htmlPath);
    requireFile(saved, evidence.screenshotPath);
    const html = await captureFile(saved.root, evidence.htmlPath);
    const root = dtcDocument(html.toString()).querySelector(evidence.catalogRoot);
    if (!root) {
      throw new Error("catalog_root_missing");
    }
    const links = [...root.querySelectorAll("a[href]")].map(
      (anchor) => new URL(anchor.getAttribute("href") ?? "", expected.sourceUrl).href,
    );
    if (JSON.stringify(links) !== JSON.stringify(proof.dom.links)) {
      throw new Error("catalog_dom_mismatch");
    }
    for (const [index, response] of proof.responses.entries()) {
      const original = await readJson(saved, `catalog-shopify-response-${index + 1}.json`);
      if (!isDeepStrictEqual(original, response)) {
        throw new Error("catalog_response_mismatch");
      }
    }
    verifyDtcCatalogCoverage(
      proof,
      expected.sourceUrl,
      expected.productUrls.map((url) => ({ url })),
    );
  } catch (cause) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE", {
      details: { reason: "catalog_shopify_proof_unverified", cause: String(cause) },
    });
  }
}

async function readJson(saved: Saved, path: string): Promise<unknown> {
  requireFile(saved, path);
  return JSON.parse((await captureFile(saved.root, path)).toString());
}

function requireFile(saved: Saved, path: string) {
  if (!saved.files.some((file) => file.path === path)) {
    throw new Error("catalog_evidence_missing");
  }
}
