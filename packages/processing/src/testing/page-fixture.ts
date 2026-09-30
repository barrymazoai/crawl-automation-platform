import { sha256 } from "@crawl-automation/platform";
import {
  acquisitionFingerprintMaterial,
  type PagePrepareInput,
  type ReviewRecord,
} from "@crawl-automation/v3-contracts";
import { PageEvidence } from "../pages/page-evidence.js";
import { pageConfigFingerprint } from "../pages/page-input.js";
import { PagePreparation } from "../pages/page-preparation.js";
import { PageTextPreparation } from "../pages/page-text.js";
import { hashString } from "../results/result-record.js";
import { MemoryStore } from "./memory-store.js";

/** A page task signed by its own fingerprint (recomputed after any change). */
export function signedPage(input: PagePrepareInput): PagePrepareInput {
  return { ...input, inputFingerprint: hashString(acquisitionFingerprintMaterial(input)) };
}

/** A page task for a captured HTML page. */
export function pageTask(html: string) {
  const bytes = Buffer.from(html);
  const input = signedPage({
    schemaVersion: 1,
    requestId: "req-1",
    observationId: "obs-1",
    operationId: "page-op-1",
    brandId: "brand-1",
    sourceId: "source-1",
    listingId: "listing-1",
    variantId: null,
    module: "page.prepare",
    implementationVersion: "1",
    policyVersion: "1",
    configFingerprint: pageConfigFingerprint,
    inputFingerprint: "0".repeat(64),
    page: {
      schemaVersion: 1,
      artifactId: "html-1",
      observationId: "obs-1",
      sourceId: "source-1",
      listingId: "listing-1",
      variantId: null,
      kind: "source-html",
      mediaType: "text/html",
      sha256: sha256(bytes),
      byteSize: bytes.length,
      objectKey: "capture/page.html",
      producer: { operationId: "capture-1", module: "capture", implementationVersion: "1" },
    },
  });
  return { input, bytes };
}

/** A captured page in R2 with page preparation and page text wired to memory stores and a Review ledger. */
export function pageSetup(
  html = '<p>Other ingredients: water</p><table><tr><td colspan="2">10 mg</td></tr></table>',
) {
  const { input, bytes } = pageTask(html);
  const local = new MemoryStore();
  const remote = new MemoryStore();
  remote.data.set(input.page.objectKey, bytes);
  const records = new Map<string, ReviewRecord>();
  const reviews = {
    read: async (id: string) => records.get(id) ?? null,
    append: async (record: ReviewRecord) => {
      records.set(record.reviewId, record);
    },
  };
  const evidence = new PageEvidence({ local, remote, reviews });
  const text = {
    schemaVersion: 1 as const,
    module: "codex.text" as const,
    implementationVersion: "codex-text/2",
    policyVersion: "anchored/2",
    resultSchemaVersion: 2 as const,
    configFingerprint: "b".repeat(64),
  };
  const plan = { page: input, textOperationId: "text-op-1", text };
  return {
    input,
    bytes,
    local,
    remote,
    reviews,
    records,
    plan,
    evidence,
    preparation: new PagePreparation(evidence),
    text: new PageTextPreparation(evidence),
  };
}

/** The same page steps on a replacement worker: same R2 and ledger, empty local store. */
export function replacementPageSteps(setup: ReturnType<typeof pageSetup>) {
  const evidence = new PageEvidence({
    local: new MemoryStore(),
    remote: setup.remote,
    reviews: setup.reviews,
  });
  return { preparation: new PagePreparation(evidence), text: new PageTextPreparation(evidence) };
}
