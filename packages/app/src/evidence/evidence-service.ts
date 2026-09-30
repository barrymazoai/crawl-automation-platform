import { appErrors } from "../errors.js";
import {
  EvidenceCaptureInputSchema,
  type EvidenceCaptureInput,
  type EvidenceCaptureResult,
} from "./evidence-model.js";
import type { EvidenceCapture } from "./ports.js";

/** Manual test evidence only: no product processing, queue, retries or browser execution. */
export class EvidenceService {
  constructor(private readonly capturePort?: EvidenceCapture) {}

  async capture(input: EvidenceCaptureInput): Promise<EvidenceCaptureResult> {
    const request = EvidenceCaptureInputSchema.parse(input);
    if (request.channel === "dtc" || request.channel === "wholefoods") {
      throw appErrors.create("EVIDENCE.BROWSER_CAPTURE_UNSUPPORTED");
    }
    if (!this.capturePort) {
      throw appErrors.create("EVIDENCE.NOT_CONFIGURED");
    }
    return this.capturePort.capture(
      { ...request, maximumAttempts: 1 },
      AbortSignal.timeout(180_000),
    );
  }
}
