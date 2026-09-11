import { type ArtifactRef, type Observation, type VisionCandidate } from "@crawl-automation/v3-contracts";
import { screenKeywords, digest } from "./keywords.js";
export const observation: Observation = { schemaVersion: 1, requestId: "request-1", observationId: "observation-1",
  brandId: "brand-1", sourceId: "source-1", listingId: "listing-1", variantId: null };
export const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
export const image: ArtifactRef = { schemaVersion: 1, artifactId: "image-1", observationId: observation.observationId,
  sourceId: observation.sourceId, listingId: observation.listingId, variantId: null, sha256: digest(bytes), byteSize: bytes.length,
  objectKey: "images/image-1.jpg", kind: "source-image", mediaType: "image/jpeg",
  producer: { operationId: "download-1", module: "file.acquire", implementationVersion: "fixture/1" } };
export const selection = (text = "Supplement Facts") => screenKeywords({ observation, image, ocrOperationId: "ocr-1", text });
const field = (text: string) => ({ text, evidence: text });
export const candidate: VisionCandidate = { schemaVersion: 1,
  formula: { servingSize: field("1 capsule"), servingsPerContainer: null,
    columns: [{ heading: "Per serving", nutrients: [{ name: field("Blend"), amount: field("10 mg"), dailyValue: null }] }] },
  ingredients: [{ name: "Ginger root", evidence: "Ginger root", role: "blend_component", parentBlend: "Blend" }],
  formulaComplete: true, ingredientsComplete: true, issues: [] };
