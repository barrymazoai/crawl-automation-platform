import type { OcrPort } from "../modules/ocr-file.js";

export class MockOcr implements OcrPort {
  submissions = 0;
  closed = false;
  async recognize(
    file: Parameters<OcrPort["recognize"]>[0],
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    if (this.closed) throw new Error("Mock OCR is closed");
    this.submissions++;
    // Deliberately no network or image recognition in P0.
    return `MOCK OCR ONLY: ${file.artifactId} / ${file.sha256}`;
  }
  async close() {
    this.closed = true;
  }
}
