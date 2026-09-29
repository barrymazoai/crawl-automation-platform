import {
  PagePrepareInputSchema,
  acquisitionFingerprintMaterial,
  type PagePrepareInput,
} from "@crawl-automation/v3-contracts";
import { hashString } from "../results/result-record.js";
import { pageFailure } from "./page-errors.js";

/** Limits of the page parser. Part of the page setup's fingerprint: changing one is a new setup. */
export const pagePolicy = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
  maxNodes: 100_000,
  maxDepth: 128,
  maxTables: 200,
  maxCells: 20_000,
});

export const pageConfigFingerprint = hashString(JSON.stringify(["page.prepare/1", pagePolicy]));

/** The page task, for exactly this page setup, signed by its own fingerprint, and never its page's producer. */
export function checkedPageInput(raw: unknown): PagePrepareInput {
  const input = PagePrepareInputSchema.parse(raw);
  const setup =
    input.implementationVersion === "1" &&
    input.policyVersion === "1" &&
    input.configFingerprint === pageConfigFingerprint;
  if (!setup) {
    throw pageFailure("RUNTIME.INCOMPATIBLE_CONSUMER");
  }
  if (hashString(acquisitionFingerprintMaterial(input)) !== input.inputFingerprint) {
    throw pageFailure("INPUT.FINGERPRINT_MISMATCH");
  }
  if (input.operationId === input.page.producer.operationId) {
    throw pageFailure("PAGE.IDENTITY_CONFLICT");
  }
  return input;
}

export const pageCompletionKey = (input: PagePrepareInput) =>
  `v3/pages/${input.operationId}/completion.json`;
