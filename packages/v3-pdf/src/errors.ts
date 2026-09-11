import type { PdfCode } from "@crawl-automation/v3-contracts";

export class PdfError extends Error {
  constructor(readonly code: PdfCode, readonly attemptId?: string) {
    super(code);
    this.name = "PdfError";
  }
}
