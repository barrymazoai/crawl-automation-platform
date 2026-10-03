import { DtcMixedGallery, DtcGalleryScope } from "@crawl-automation/channel-dtc";
import { CodexClient, CodexVisionConfigSchema } from "@crawl-automation/processing";
import {
  OcrOutputSchema,
  assertProcessingResultMatches,
  observationIdentity,
  DtcGalleryFinishSchema,
  type OcrInput,
} from "@crawl-automation/v3-contracts";
import { verifyBytes } from "@crawl-automation/platform";
import type { WorkerParts } from "../container.js";
import { guarded } from "./activity-guard.js";

export function dtcGalleryPipelineActivities(parts: WorkerParts) {
  const gallery = () => new DtcMixedGallery(parts.publication);
  return {
    prepareDtcGallery: guarded(
      "prepareDtcGallery",
      async (raw, signal) => {
        const settings = parts.config.label?.shared;
        const resources = settings?.resources;
        const ocr = resources?.activities["ocrFile"];
        const vision = resources?.activities["interpretImage"];
        if (!settings || !resources || ![ocr, vision].every((needs) => needs && needs.length)) {
          throw new Error("DTC.GALLERY_SETTINGS");
        }
        return {
          ...(await gallery().prepare(raw, signal)),
          queues: settings.queues,
          resources: { ...resources, activities: { ocrFile: ocr, scopeDtcGalleryImage: vision } },
        };
      },
      parts.log,
    ),
    finishDtcGallery: guarded(
      "finishDtcGallery",
      (raw, signal) => gallery().finish(DtcGalleryFinishSchema.parse(raw), signal),
      parts.log,
    ),
  };
}

export function dtcGalleryModelActivities(parts: WorkerParts) {
  return {
    scopeDtcGalleryImage: guarded(
      "scopeDtcGalleryImage",
      async (raw, signal) => {
        const client = await galleryModel(parts);
        try {
          return await new DtcGalleryScope(new DtcMixedGallery(parts.publication), {
            ocr: (input, active) => readOcr(parts, input, active),
            image: async (input, active) =>
              (
                await parts.label.stores.artifacts.resolve(
                  input.file,
                  observationIdentity(input),
                  active,
                )
              ).bytes,
            model: (call, active) => client.run(call, active),
          }).run(raw, signal);
        } finally {
          await client.close();
        }
      },
      parts.log,
    ),
  };
}

function galleryModel(parts: WorkerParts) {
  const config = CodexVisionConfigSchema.parse(parts.config.processing?.codex?.vision);
  const {
    extractionProtocol: _protocol,
    visualProtocol: _visual,
    ingredientPresencePolicy: _policy,
    ...settings
  } = config;
  return CodexClient.open(settings, {
    environment: process.env,
    profile: {
      workspace: "vision-",
      modalities: ["text", "image"],
      renameError: (error) => error,
      privateConfig: () => new Error("DTC.GALLERY_SETTINGS"),
      closed: () => new Error("DTC.GALLERY_MODEL_CLOSED"),
    },
  });
}

async function readOcr(parts: WorkerParts, input: OcrInput, active: AbortSignal) {
  const found = await parts.label.stores.ocrResults.inspect(input, active);
  if (!found.record || !found.artifactDurable || !found.resultRegistered) {
    throw new Error("DTC.GALLERY_OCR_UNVERIFIED");
  }
  const result = found.record.result;
  const bytes = await parts.r2.store.read(result.objectKey, result.byteSize, active);
  if (!bytes) {
    throw new Error("DTC.GALLERY_OCR_MISSING");
  }
  verifyBytes(result, bytes, 2_000_000);
  const output = OcrOutputSchema.parse(JSON.parse(Buffer.from(bytes).toString()));
  assertProcessingResultMatches(input, output, "output");
  return { output, result };
}
