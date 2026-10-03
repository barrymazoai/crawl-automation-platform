import { DtcProductScope, dtcAgentErrors } from "@crawl-automation/channel-dtc";
import { CodexClient } from "@crawl-automation/processing";
import type { CoreParts } from "../core-parts.js";

/** Uses the already-held native capture model permit, after its browser page has closed. */
export function dtcProductScope(parts: Pick<CoreParts, "config" | "publication">) {
  return new DtcProductScope(parts.publication, async (call, signal) => {
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
        closed: () => dtcAgentErrors.create("DTC.PRODUCT_SCOPE_UNRESOLVED"),
      },
    });
    try {
      return await client.run(call, signal);
    } finally {
      await client.close();
    }
  });
}
