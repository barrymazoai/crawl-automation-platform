import { createHash } from "node:crypto";
import {
  acquisitionFingerprintMaterial,
  FileAcquireInputSchema,
  type FileAcquireInput,
} from "@crawl-automation/v3-contracts";
import { fileErrors } from "./file-errors.js";

export const fileHash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** Persisted file.acquire/1 policy. Property order is part of its fingerprint. */
export const FILE_POLICY = Object.freeze({
  maxBytes: 32 * 1024 * 1024,
  maxPixels: 40000000,
  maxRedirects: 3,
  timeoutMs: 30000,
});
export const FILE_CONFIG_FINGERPRINT = fileHash(JSON.stringify(["file.acquire/1", FILE_POLICY]));
export const acquiredImageId = (operationId: string) => `file-${fileHash(operationId)}`;
export const acquisitionKey = (input: FileAcquireInput) =>
  `v3/acquisition/${input.operationId}/completion.json`;

export function checkedFileInput(raw: unknown): FileAcquireInput {
  const input = FileAcquireInputSchema.parse(raw);
  if (
    input.implementationVersion !== "1" ||
    input.policyVersion !== "1" ||
    input.configFingerprint !== FILE_CONFIG_FINGERPRINT
  ) {
    throw fileErrors.create("RUNTIME.INCOMPATIBLE_CONSUMER");
  }
  if (fileHash(acquisitionFingerprintMaterial(input)) !== input.inputFingerprint) {
    throw fileErrors.create("INPUT.FINGERPRINT_MISMATCH");
  }
  return input;
}
