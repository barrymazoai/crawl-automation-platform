import { createHash } from "node:crypto";
import { assertOcrCompatibility, fingerprintOcrInput, parseOcrInput, type OcrInput } from "@crawl-automation/v3-contracts";
import { SUPPORTED } from "./index.js";

export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const fingerprint = (input: Omit<OcrInput, "inputFingerprint">) => fingerprintOcrInput(input, sha256);
export function validateInput(raw: unknown): OcrInput {
  const input = parseOcrInput(raw, sha256);
  assertOcrCompatibility(input, SUPPORTED);
  return input;
}
