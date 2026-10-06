import { z } from "zod";
import { sha256 } from "@crawl-automation/platform";
import {
  DtcGalleryTaskSchema,
  DtcGalleryRequestSchema,
  fingerprintOcrInput,
  OcrInputSchema,
  SourceImageSchema,
  type ChannelPlanInput,
  type DtcVariantHandoff,
} from "@crawl-automation/v3-contracts";
import { GalleryStore, galleryEvidence as evidence } from "./gallery-store.js";
import { CaptureFileSchema } from "./archive.js";
const Images = z.strictObject({
  version: z.literal("dtc-agent-images/1"),
  url: z.url(),
  images: z
    .array(CaptureFileSchema.extend({ url: z.url() }))
    .min(1)
    .max(100),
});
export async function prepareGalleryTask(store: GalleryStore, raw: unknown, signal: AbortSignal) {
  const request = DtcGalleryRequestSchema.parse(raw);
  const { sourcePlan, variants } = request;
  if (sourcePlan.channel !== "dtc" || !variants.some((member) => member.status === "mixed")) {
    throw new Error("DTC.GALLERY_REQUEST");
  }
  const parent = evidence(await store.read(sourcePlan.source, signal));
  if (
    parent.listingId !== sourcePlan.owner.listingId ||
    parent.variantId !== sourcePlan.owner.variantId
  ) {
    throw new Error("DTC.GALLERY_OWNER");
  }
  await verifyMembers(store, { sourcePlan, variants, parent }, signal);
  const manifest = await readImages(store, { sourcePlan, parent }, signal);
  const captureId = sourcePlan.source.producer.operationId;
  // Only raster images reach OCR; a website's SVG badges or icons are listed, never a reason to drop the gallery.
  const readable = manifest.images.filter((image) => ocrReadable(image.mediaType));
  if (readable.length === 0) {
    throw new Error("DTC.GALLERY_IMAGE_UNSUPPORTED");
  }
  const images = readable.map((image) => imageTask(sourcePlan, image));
  const unreadable = manifest.images
    .filter((image) => !ocrReadable(image.mediaType))
    .map((image) => ({ url: image.url, mediaType: image.mediaType }));
  const task = DtcGalleryTaskSchema.parse({
    ...request,
    websiteVariants: parent.variants,
    images,
    ...(unreadable.length ? { unreadable } : {}),
  });
  return {
    task: await store.save(`v3/dtc-agent/${captureId}/mixed-gallery/task.json`, task, signal),
    inputs: images.map((image) => image.input),
  };
}

async function verifyMembers(
  store: GalleryStore,
  context: {
    sourcePlan: ChannelPlanInput;
    variants: DtcVariantHandoff[];
    parent: ReturnType<typeof evidence>;
  },
  signal: AbortSignal,
) {
  const { sourcePlan, variants, parent } = context;
  for (const member of variants) {
    const actual = parent.variants.find((item) => item.variantId === member.variant.variantId);
    if (!actual || JSON.stringify(actual) !== JSON.stringify(member.variant)) {
      throw new Error("DTC.GALLERY_VARIANT");
    }
    if (member.status !== "mixed") {
      continue;
    }
    const plan = member.planned.sourcePlan;
    if (
      plan.owner.variantId !== member.variant.variantId ||
      plan.channel !== "dtc" ||
      (["listingId", "requestId", "sourceId", "brandId"] as const).some(
        (field) => plan.owner[field] !== sourcePlan.owner[field],
      )
    ) {
      throw new Error("DTC.GALLERY_OWNER");
    }
    const draft = evidence(await store.read(plan.source, signal));
    if (draft.variantId !== member.variant.variantId || draft.listingId !== parent.listingId) {
      throw new Error("DTC.GALLERY_OWNER");
    }
  }
}

async function readImages(
  store: GalleryStore,
  context: { sourcePlan: ChannelPlanInput; parent: ReturnType<typeof evidence> },
  signal: AbortSignal,
) {
  const { sourcePlan, parent } = context;
  const captureId = sourcePlan.source.producer.operationId;
  const bytes = await store.publication.remote.read(
    `v3/dtc-agent/${captureId}/images.json`,
    1_000_000,
    signal,
  );
  const manifest = Images.parse(bytes ? JSON.parse(Buffer.from(bytes).toString()) : null);
  if (
    manifest.url !== sourcePlan.expectedUrl ||
    new Set(manifest.images.map((image) => image.url)).size !== manifest.images.length ||
    manifest.images.length !== parent.imageCandidates.length ||
    parent.imageCandidates.some(
      (image) => !manifest.images.some((saved) => saved.url === image.url),
    )
  ) {
    throw new Error("DTC.GALLERY_INCOMPLETE");
  }
  return manifest;
}

function ocrReadable(mediaType: string): boolean {
  return SourceImageSchema.shape.mediaType.safeParse(mediaType).success;
}

function imageTask(sourcePlan: ChannelPlanInput, image: z.infer<typeof Images>["images"][number]) {
  const captureId = sourcePlan.source.producer.operationId;
  const key = sha256(Buffer.from(JSON.stringify([captureId, image.url, image.sha256])));
  const { requestId: _request, brandId: _brand, ...owner } = sourcePlan.owner;
  const unsigned = {
    ...sourcePlan.owner,
    ...sourcePlan.ocr,
    operationId: `dtc-gallery-ocr-${key}`,
    file: {
      ...owner,
      artifactId: `dtc-gallery-image-${key}`,
      kind: "source-image" as const,
      objectKey: image.objectKey,
      sha256: image.sha256,
      byteSize: image.byteSize,
      mediaType: image.mediaType,
      producer: {
        operationId: captureId,
        module: "dtc.browser-original",
        implementationVersion: "dtc-agent/1",
      },
    },
  };
  const parsed = OcrInputSchema.safeParse({ ...unsigned, inputFingerprint: "0".repeat(64) });
  if (!parsed.success) {
    throw new Error("DTC.GALLERY_IMAGE_UNSUPPORTED");
  }
  const input = OcrInputSchema.parse({
    ...parsed.data,
    inputFingerprint: fingerprintOcrInput(parsed.data, (value) => sha256(Buffer.from(value))),
  });
  return { url: image.url, input };
}
