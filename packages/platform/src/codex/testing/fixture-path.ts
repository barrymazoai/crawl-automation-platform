import { fileURLToPath } from "node:url";

/** Test-only executable path; importing it does not start the fake server. */
export const fakeCodexServerPath = fileURLToPath(
  new URL("./fake-codex-server.ts", import.meta.url),
);
