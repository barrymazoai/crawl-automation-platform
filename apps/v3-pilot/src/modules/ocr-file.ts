import type { OcrInput, OcrOutput } from "../contracts/index.js";
import { processingIdentity } from "@crawl-automation/v3-contracts";

export interface OcrPort {
  recognize(file: OcrInput["file"], signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}
export interface OperationContext {
  operationId: string;
  signal: AbortSignal;
}
export async function recognizeFile(
  input: OcrInput,
  ports: { ocr: OcrPort; context: OperationContext },
): Promise<OcrOutput> {
  ports.context.signal.throwIfAborted();
  if (ports.context.operationId !== input.operationId)
    throw new Error("Operation scope mismatch");
  // This isolated text-only mock cannot produce the v2 provider evidence contract.
  if (input.resultSchemaVersion !== 1) throw new Error("RUNTIME.INCOMPATIBLE_CONSUMER:resultSchemaVersion");
  const text = await ports.ocr.recognize(input.file, ports.context.signal);
  return {
    ...processingIdentity(input),
    resultSchemaVersion: input.resultSchemaVersion,
    text,
    provider: "mock-no-network",
  };
}
