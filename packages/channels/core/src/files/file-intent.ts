import { randomUUID } from "node:crypto";
import type { ObjectStore } from "@crawl-automation/platform";
import { FileAcquireInputSchema, type FileAcquireInput } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { equalFileJson } from "./file-evidence.js";
import { fileErrors } from "./file-errors.js";

const intentSchema = z.strictObject({ input: FileAcquireInputSchema, nonce: z.uuid() });

/** A conditional, one-shot claim. Unknown publication never authorizes another download. */
export async function claimFile(remote: ObjectStore, input: FileAcquireInput, signal: AbortSignal) {
  const key = `acquisition-intents/${input.operationId}.json`;
  const proposed = intentSchema.parse({ input, nonce: randomUUID() });
  let created: "created" | "exists";
  try {
    created = await remote.create(
      key,
      Buffer.from(JSON.stringify(proposed)),
      "application/json",
      signal,
    );
  } catch (cause) {
    throw fileErrors.create("ACQUIRE.INTENT_UNKNOWN", { cause });
  }
  const saved = await remote.read(key, 65536, signal);
  if (
    !saved ||
    !equalFileJson(intentSchema.parse(JSON.parse(Buffer.from(saved).toString())), proposed)
  ) {
    throw fileErrors.create(
      created === "exists" ? "ACQUIRE.EXECUTION_UNKNOWN" : "ACQUIRE.INTENT_UNKNOWN",
    );
  }
  if (created !== "created") {
    throw fileErrors.create("ACQUIRE.EXECUTION_UNKNOWN");
  }
}
