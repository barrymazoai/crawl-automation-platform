import { ApplicationFailure } from "@temporalio/common";
import { cancellationSignal } from "@temporalio/activity";
import { validateInput } from "../contracts/fingerprint.js";
import type {
  Completion,
  OcrInput,
  Review,
  Verification,
} from "../contracts/index.js";
import { recognizeFile } from "../modules/ocr-file.js";
import { withOperation, type WorkerContainer } from "../bootstrap/container.js";

export function createActivities(
  container: WorkerContainer,
  signal: () => AbortSignal = cancellationSignal,
) {
  return {
    async ocrFile(raw: OcrInput): Promise<Completion> {
      const input = validateInput(raw);
      return withOperation(
        container,
        { operationId: input.operationId, signal: signal() },
        async (ports) => {
          const previous = await ports.evidence.verify(input);
          if (previous.status === "verified") return previous.completion;
          if (!(await ports.evidence.reserve(input))) {
            const checked = await ports.evidence.verify(input);
            if (checked.status === "verified") return checked.completion;
            throw ApplicationFailure.nonRetryable(
              "Existing operation has no matching complete proof",
              checked.code,
            );
          }
          const output = await recognizeFile(input, ports);
          return ports.evidence.complete(input, output);
        },
      );
    },
    async verifyOcr(raw: OcrInput): Promise<Verification> {
      return container.resolve("evidence").verify(validateInput(raw));
    },
    async consumeOcr(raw: OcrInput, completion: Completion): Promise<number> {
      const output = await container
        .resolve("evidence")
        .read(validateInput(raw), completion);
      return output.text.length;
    },
    async recordReview(review: Review): Promise<string> {
      return container.resolve("evidence").recordReview(review);
    },
  };
}
export type Activities = ReturnType<typeof createActivities>;
