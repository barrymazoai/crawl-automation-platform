import type {
  Completion,
  OcrInput,
  OcrOutput,
  Review,
  Verification,
} from "../contracts/index.js";

export interface EvidencePort {
  reserve(input: OcrInput): Promise<boolean>;
  complete(input: OcrInput, output: OcrOutput): Promise<Completion>;
  verify(input: OcrInput): Promise<Verification>;
  read(input: OcrInput, completion: Completion): Promise<OcrOutput>;
  recordReview(review: Review): Promise<string>;
}
