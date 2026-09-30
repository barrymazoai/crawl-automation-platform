import {
  ArtifactRefSchema,
  ChannelProductPlanSchema,
  FileAcquireInputSchema,
  PagePrepareInputSchema,
  acquisitionFingerprintMaterial,
  type ArtifactRef,
  type ChannelPlanInput,
  type ChannelProductEvidence,
  type ChannelProductPlan,
} from "@crawl-automation/v3-contracts";
import {
  FILE_CONFIG_FINGERPRINT,
  FRAGMENT_LIMIT,
  PAGE_CONFIG_FINGERPRINT,
  PLAN_LIMIT,
  acquiredImageId,
  encodeJson,
  fingerprinted,
  planTaskId,
} from "./plan-codec.js";
import { planErrors } from "./plan-errors.js";
import type { PlannedProduct } from "../adapter.js";

type Sources = ChannelProductPlan["manifest"]["sources"];
type Files = ChannelProductPlan["files"];
type ImageCandidate = ChannelProductEvidence["imageCandidates"][number];

/** The page text the text step reads: the selected product's facts plus its details, never the whole page. */
function fragmentOf(input: ChannelPlanInput, evidence: ChannelProductEvidence) {
  const selected = evidence.factsCandidates.filter((facts) => facts.scope === "selected-product");
  const html = [...selected.map((facts) => facts.html), evidence.detailsHtml]
    .filter(Boolean)
    .join("\n");
  const bytes = Buffer.from(html);
  if (!html) {
    return { fragment: null, bytes };
  }
  const { owner, operationId } = input;
  const fragment = ArtifactRefSchema.parse({
    schemaVersion: 1,
    artifactId: planTaskId(operationId, "fragment"),
    observationId: owner.observationId,
    sourceId: owner.sourceId,
    listingId: owner.listingId,
    variantId: owner.variantId,
    kind: "source-html",
    mediaType: "text/html",
    objectKey: `v3/channel-plans/${operationId}/derived.html`,
    byteSize: bytes.length,
    sha256: fingerprinted(html),
    producer: {
      operationId,
      module: "channel.product-input",
      implementationVersion: "channel-plan/1",
    },
  });
  return { fragment, bytes };
}

function pageSource(input: ChannelPlanInput, fragment: ArtifactRef, required: boolean) {
  const raw = PagePrepareInputSchema.parse({
    ...input.owner,
    operationId: planTaskId(input.operationId, "page"),
    module: "page.prepare",
    implementationVersion: "1",
    policyVersion: "1",
    configFingerprint: PAGE_CONFIG_FINGERPRINT,
    page: fragment,
    inputFingerprint: "0".repeat(64),
  });
  const inputFingerprint = fingerprinted(acquisitionFingerprintMaterial(raw));
  const page = PagePrepareInputSchema.parse({ ...raw, inputFingerprint });
  const textOperationId = planTaskId(input.operationId, "text");
  return {
    id: "page",
    kind: "page",
    required,
    plan: { page, textOperationId, text: input.text },
  } as const;
}

function imageSource(input: ChannelPlanInput, index: number) {
  const task = (role: string) => planTaskId(input.operationId, `${role}-${index}`);
  const raw = FileAcquireInputSchema.parse({
    ...input.owner,
    operationId: task("file"),
    module: "file.acquire",
    implementationVersion: "1",
    policyVersion: "1",
    configFingerprint: FILE_CONFIG_FINGERPRINT,
    resourceId: task("resource"),
    binding: input.binding,
    expectedSha256: null,
    inputFingerprint: "0".repeat(64),
  });
  const inputFingerprint = fingerprinted(acquisitionFingerprintMaterial(raw));
  const acquire = FileAcquireInputSchema.parse({ ...raw, inputFingerprint });
  const imageId = acquiredImageId(acquire.operationId);
  const plan = { imageId, acquire, ocrOperationId: task("ocr"), ocr: input.ocr };
  const configFingerprint = input.visionConfigFingerprint;
  const id = `image-${index}`;
  return {
    id,
    kind: "file-image",
    required: false,
    plan,
    visionOperationId: task("vision"),
    configFingerprint,
  } as const;
}

/** PDFs are not read (owner, 2026-09-30): they are left out of the plan instead of being downloaded and skipped. */
const isPdf = (image: ImageCandidate) => /\.pdf$/i.test(new URL(image.url).pathname);

/** Every product image except PDFs, each at its position on the page (so task IDs never shift). */
function imageSources(input: ChannelPlanInput, evidence: ChannelProductEvidence) {
  const sources: Sources = [];
  const files: Files = [];
  for (const [index, image] of evidence.imageCandidates.entries()) {
    if (image.variantId !== input.owner.variantId) {
      throw planErrors.create("CHANNEL.VARIANT_CONFLICT");
    }
    if (isPdf(image)) {
      continue;
    }
    const source = imageSource(input, index);
    sources.push(source);
    files.push({ resourceId: source.plan.acquire.resourceId, url: image.url });
  }
  return { sources, files };
}

function taskOperations(sources: Sources): string[] {
  return sources.flatMap((source) => {
    if (source.kind === "file-image") {
      return [
        source.plan.acquire.operationId,
        source.plan.ocrOperationId,
        source.visionOperationId,
      ];
    }
    return source.kind === "page"
      ? [source.plan.page.operationId, source.plan.textOperationId]
      : [];
  });
}

/**
 * text-facts-first/1: when the adapter judges the selected product's facts text complete, that page text is the only
 * (required) formula source and no image is planned; otherwise the page text and every image are planned.
 */
export function buildPlan(input: ChannelPlanInput, product: PlannedProduct) {
  const { evidence, facts } = product;
  const { fragment, bytes } = fragmentOf(input, evidence);
  const textOnly = input.factsPolicy === "text-facts-first/1" && !!fragment && facts.complete;
  const page = fragment ? [pageSource(input, fragment, textOnly)] : [];
  const images = textOnly ? { sources: [], files: [] } : imageSources(input, evidence);
  const sources: Sources = [...page, ...images.sources];
  if (!sources.length) {
    throw planErrors.create("CHANNEL.NO_PRODUCT_SOURCES");
  }
  const manifest = { operationId: input.operationId, observation: input.owner, sources };
  const plan = ChannelProductPlanSchema.parse({
    codec: "channel-plan/1",
    input,
    product: evidence,
    fragment,
    files: images.files,
    manifest,
  });
  if (taskOperations(sources).includes(input.source.producer.operationId)) {
    throw planErrors.create("CHANNEL.OPERATION_CONFLICT");
  }
  if (encodeJson(plan).length > PLAN_LIMIT || bytes.length > FRAGMENT_LIMIT) {
    throw planErrors.create("CHANNEL.OUTPUT_LIMIT");
  }
  return { plan, bytes };
}
