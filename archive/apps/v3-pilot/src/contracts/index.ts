// P0 deployment policy only. Wire schemas live exclusively in the shared package.
import type { Completion, ReviewCode } from "@crawl-automation/v3-contracts";
export {
  ArtifactRefSchema, OcrInputSchema, CompletionSchema, OcrOutputSchema, ReviewSchema,
  ReviewCodeSchema, VerificationSchema,
  type OcrInput, type ArtifactRef, type Completion, type OcrOutput, type Review,
  type ReviewCode, type Verification,
} from "@crawl-automation/v3-contracts";
export const IMPLEMENTATION = "mock-ocr/1";
export const POLICY = "p0-single-file/1";
// SHA-256 of public config string p0:mock-no-network:1, generated in the fixture/runtime.
export const CONFIG = "p0:mock-no-network:1";
export const SUPPORTED = {
  module: "ocr.file", schemaVersion: 1, resultSchemaVersion: 1,
  implementationVersion: IMPLEMENTATION, policyVersion: POLICY,
  configFingerprint: "a6c652773186f8642039a18f2c2539067348bd2a49fb4fcf1eaa9bf3c78b68f3",
} as const;
export type PilotOutcome =
  | {
      businessOutcome: "processed";
      completion: Completion;
      characterCount: number;
    }
  | { businessOutcome: "review"; reviewKey: string; code: ReviewCode };

export const QUEUES = {
  workflow: "v3.p0.shared-v1.workflow",
  ocr: "v3.p0.shared-v1.ocr.file.mock",
  handoff: "v3.p0.shared-v1.handoff.local",
  consume: "v3.p0.shared-v1.consume.mock",
} as const;
