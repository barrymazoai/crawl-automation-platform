import { PostgresResourceStore } from "@crawl-automation/adapters";
import { dtcAgentErrors } from "@crawl-automation/channel-dtc";
import { currentPermitExecution } from "@crawl-automation/platform";
import { CodexClient } from "@crawl-automation/processing";
import type { CoreParts } from "../core-parts.js";

/** One text-only call with the DTC agent's model settings, inside an activity that already holds the model permit. */
export function dtcModelCall(parts: Pick<CoreParts, "config">, closed: () => Error) {
  return async (call: { prompt: string; outputSchema: object }, signal: AbortSignal) => {
    const settings = parts.config.browser?.dtcAgent?.codex;
    if (!settings) {
      throw dtcAgentErrors.create("DTC.AGENT_REQUIRED");
    }
    const client = await CodexClient.open(settings, {
      environment: process.env,
      profile: {
        workspace: "execution-",
        modalities: ["text"],
        renameError: (error) => error,
        privateConfig: () => dtcAgentErrors.create("DTC.AGENT_REQUIRED"),
        closed,
      },
    });
    try {
      return await client.run(call, signal);
    } finally {
      await client.close();
    }
  };
}

/** The calling activity's permit must hold the DTC agent's model resource. */
export async function verifyDtcModelPermit(parts: Pick<CoreParts, "config" | "database">) {
  const owner = currentPermitExecution();
  const resource = parts.config.browser?.dtcAgent?.modelResourceId;
  const held = owner
    ? await new PostgresResourceStore(parts.database).findHeld(owner.permitId)
    : null;
  if (
    !owner ||
    !resource ||
    !held?.resources.includes(resource) ||
    held.workflowId !== owner.workflowId ||
    held.runId !== owner.runId
  ) {
    throw dtcAgentErrors.create("DTC.AGENT_REQUIRED", {
      details: { reason: "capture_model_permit_required" },
    });
  }
}
