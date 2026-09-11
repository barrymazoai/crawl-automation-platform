import type { OcrInput, OcrResponse, ProcessingCompatibility } from "@crawl-automation/v3-contracts";
export class OcrError extends Error {
  constructor(readonly code: string, readonly executionFact: "not_executed" | "executed" | "unknown" = "unknown") {
    super(code); this.name = "OcrError";
  }
}
export interface OcrProvider {
  readonly provider: string;
  readonly supported: ProcessingCompatibility;
  recognize(file: OcrInput["file"], bytes: Uint8Array, signal: AbortSignal): Promise<OcrResponse>;
  close(): Promise<void>;
}
