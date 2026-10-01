import { PostgresCollectedProducts } from "@crawl-automation/adapters";
import {
  ImageOcrTask,
  KeywordScreening,
  LabelAssembly,
  LabelCollection,
  LabelCoreStep,
  LabelImageSelection,
  LabelPlans,
  OcrReceipt,
  PackagingEvidence,
  PagePreparation,
  PageTextPreparation,
  SavedSourceEvidence,
  TextReceipt,
  visionTaskFingerprint,
  type LabelInspection,
  type ProductPlanReader,
} from "@crawl-automation/processing";
import type { SavedEvidenceSource } from "@crawl-automation/v3-contracts";
import type { CoreParts } from "../core-parts.js";
import type { LabelStores } from "./label-stores.js";
import { labelSourceReader } from "./label-source-reader.js";
import { measuredLabelPlans } from "../activities/activity-provider-context.js";

/** The label steps that need no model and no OCR API: plans, pages, receipts, keywords, assembly and collection. */
export interface LabelSteps {
  plans: LabelPlans;
  selection: LabelImageSelection;
  labelCore: LabelCoreStep;
  pagePreparation: PagePreparation;
  pageText: PageTextPreparation;
  imageTask: ImageOcrTask;
  ocrReceipt: OcrReceipt;
  keywords: KeywordScreening;
  textReceipt: TextReceipt;
  assembly: LabelAssembly;
  collection: LabelCollection;
}

/** The channel's saved formula plan, as the label plans read it. */
function planReader(parts: CoreParts): ProductPlanReader {
  return {
    async inspect(plan, signal) {
      const saved = await parts.channelPlans.inspect(plan.input, signal);
      return saved
        ? {
            manifest: saved.manifest,
            files: saved.files,
            ...(saved.labelPreparation ? { labelPreparation: saved.labelPreparation } : {}),
          }
        : null;
    },
  };
}

export function labelSteps(parts: CoreParts, stores: LabelStores): LabelSteps {
  const { local, remote, reviews, pages, downloads, ocrText } = stores;
  const saved = savedEvidence(stores);
  const labelCore = new LabelCoreStep({
    artifacts: stores.artifacts,
    remote,
    policies: stores.labelCores,
  });
  // A fresh source has no receipt yet: its evidence alone says what it resolved to.
  const resolve = (source: SavedEvidenceSource, signal: AbortSignal) =>
    saved.resolve(source, { id: source.id, status: "unresolved" }, signal);
  const plans = measuredLabelPlans(
    new LabelPlans({
      plans: planReader(parts),
      publication: parts.publication,
      resolve,
      core: labelCore,
    }),
  );
  const inspection = labelInspection(stores, saved);
  const assembly = assemblyStep(stores);
  const registry = new PostgresCollectedProducts(parts.database);
  return {
    plans,
    selection: new LabelImageSelection(plans, {
      inspection,
      visionFingerprint: visionTaskFingerprint,
    }),
    labelCore,
    pagePreparation: new PagePreparation(pages),
    pageText: new PageTextPreparation(pages),
    imageTask: new ImageOcrTask({ downloads, local, remote, reviews }),
    ocrReceipt: new OcrReceipt({ results: stores.ocrResults, local, reviews }),
    keywords: new KeywordScreening({ text: ocrText, local, remote, reviews }),
    textReceipt: new TextReceipt({ results: stores.textResults, local, reviews }),
    assembly,
    collection: new LabelCollection({ local, remote, reviews, assembly, registry }),
  };
}

/** What a saved source's prepared evidence resolves to, read from that evidence only. */
function savedEvidence(stores: LabelStores): SavedSourceEvidence {
  const { remote, pages, downloads, reviews } = stores;
  return new SavedSourceEvidence({
    remote,
    files: downloads,
    pages,
    ocr: stores.ocrRegistry,
    screen: stores.ocrText,
    reviews,
    visionFingerprint: visionTaskFingerprint,
  });
}

/** Assembly re-reads every registered source and, for packaging admission, the product's full page documents. */
function assemblyStep(stores: LabelStores): LabelAssembly {
  const { local, remote, reviews, artifacts } = stores;
  const packaging = new PackagingEvidence(artifacts);
  return new LabelAssembly({
    local,
    remote,
    reviews,
    readSource: labelSourceReader(stores),
    readPackaging: (manifest, signal) =>
      packaging.inspect(manifest.observation, manifest.admission?.documents ?? [], signal),
    visionFingerprint: visionTaskFingerprint,
  });
}

/** How image-first selection inspects evidence: a download, a registered vision answer, a Review. */
function labelInspection(stores: LabelStores, saved: SavedSourceEvidence): LabelInspection {
  return {
    readSource: labelSourceReader(stores),
    file: async (source, signal) =>
      source.kind === "file-image" &&
      !!(await stores.downloads.inspect(source.plan.acquire, signal)),
    image: async (source, signal) =>
      (await stores.visionRecovery.readLabelCandidate(source.task, signal)).candidate,
    review: (reviewId) => stores.reviews.read(reviewId),
    reviewSource: (source, state, signal) => saved.resolve(source, state, signal),
  };
}
