import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TextInputSchema, type TextInput } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/platform";
import { claimIntent, type IntentFailure } from "../../step/intent-claim.js";
import { textFailure, type TextErrorCode } from "../errors.js";
import { textLimits } from "../limits.js";
import { textKeys } from "../results/text-record.js";

const TextIntentSchema = z.object({
  input: TextInputSchema,
  storageId: z.string(),
  nonce: z.string(),
});

const failureCodes: Record<IntentFailure, TextErrorCode> = {
  intentUnknown: "TEXT.INTENT_UNKNOWN",
  intentConflict: "TEXT.INTENT_CONFLICT",
  executionUnknown: "TEXT.EXECUTION_UNKNOWN",
};

/** Claims the right to call the model for this task (see claimIntent). */
export function claimTextIntent(
  remote: ObjectStore,
  claim: { input: TextInput; storageId: string; nodeId: string },
  signal: AbortSignal,
): Promise<void> {
  const { input, storageId, nodeId } = claim;
  const intent = { schemaVersion: 1, input, storageId, nodeId, nonce: randomUUID() };
  return claimIntent(
    {
      store: remote,
      key: textKeys.intent(input),
      intent,
      parse: (raw) => TextIntentSchema.parse(raw),
      limit: textLimits.resultBytes,
      fail: (reason, cause) => textFailure(failureCodes[reason], "unknown", cause),
    },
    signal,
  );
}
