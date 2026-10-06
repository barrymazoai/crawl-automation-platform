import { defineErrors } from "./define-errors.js";

const reasons = {
  CATALOG_PROVIDER_MISMATCH: "The effective provider differs from the configured provider.",
  NO_RETRY_PROFILE: "The provider profile permits retries or inherited overrides.",
  RUNTIME_PROFILE: "The runtime has an enabled MCP server.",
  CATALOG_AMBIGUOUS: "The model catalog has multiple matching entries.",
  MODEL_UNAVAILABLE: "The configured model is absent from the catalog.",
  TEXT_UNSUPPORTED: "The model does not advertise text input.",
  IMAGE_UNSUPPORTED: "The model does not advertise image input.",
  EFFORT_UNSUPPORTED: "The model does not advertise the configured reasoning effort.",
  CATALOG_CURSOR_LOOP: "The model catalog repeated a cursor.",
  CATALOG_LIMIT: "The model catalog exceeded its page limit.",
  PREFLIGHT_INVALID: "The model preflight could not be verified.",
  CONFIG_MISMATCH: "The thread settings differ from the requested settings.",
  TURN_FAILED: "The model turn failed.",
  TURN_CONFLICT: "The connection reported conflicting turn identifiers.",
  CANCELLED: "The Codex operation was cancelled.",
  PROTOCOL: "The app-server returned an invalid protocol message.",
  OUTPUT_LIMIT: "The app-server exceeded its output limit.",
  OUTPUT_MISSING: "The completed turn has no final answer.",
  EXITED: "The owned app-server exited.",
  MODEL_CAPACITY: "The model provider was at capacity before any work started.",
  SPAWN: "The app-server could not start.",
  TRANSPORT: "The app-server transport failed.",
  SERVER_REQUEST: "The app-server requested an unsupported client operation.",
  REQUEST_FAILED: "The app-server request failed.",
  CLOSED: "The app-server connection is closed.",
  TIMEOUT: "The app-server request timed out.",
  STOP_UNCONFIRMED: "The owned app-server did not confirm its exit.",
} as const;

type CodexReason = keyof typeof reasons;
type CodexCode<Area extends string> = `${Area}.CODEX_${CodexReason}`;

function codesFor<Area extends "TEXT" | "VISION">(area: Area) {
  return Object.fromEntries(
    Object.entries(reasons).map(([reason, message]) => [
      `${area}.CODEX_${reason}`,
      { category: "PROCESSING" as const, message },
    ]),
  ) as Record<CodexCode<Area>, { category: "PROCESSING"; message: string }>;
}

/** Existing stored text and vision codes keep their spelling across the move. */
export const codexErrors = defineErrors({ ...codesFor("TEXT"), ...codesFor("VISION") });
export type CodexErrorCode = keyof typeof codexErrors.codes;
