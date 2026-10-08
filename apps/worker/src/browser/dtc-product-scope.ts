import { DtcProductScope, dtcAgentErrors } from "@crawl-automation/channel-dtc";
import type { CoreParts } from "../core-parts.js";
import { dtcModelCall } from "./dtc-model.js";

/** Uses the already-held native capture model permit, after its browser page has closed. */
export function dtcProductScope(parts: Pick<CoreParts, "config" | "publication">) {
  return new DtcProductScope(
    parts.publication,
    dtcModelCall(parts, () => dtcAgentErrors.create("DTC.PRODUCT_SCOPE_UNRESOLVED")),
  );
}
