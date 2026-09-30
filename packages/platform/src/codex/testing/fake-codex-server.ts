// Owned stdio fixture only: never executes Codex or calls a network endpoint.
import { createInterface } from "node:readline";
import type { FixtureMessage } from "./fixture-protocol.js";
import { textServer } from "./text-server.js";
import { visionServer } from "./vision-server.js";

// Text keeps the original scenario names; vision uses vision, vision-text-only, vision-label-result.
const scenario = process.argv[2] ?? "success";
const handle =
  scenario === "vision" || scenario.startsWith("vision-")
    ? visionServer(scenario.slice("vision-".length))
    : textServer(scenario);

createInterface({ input: process.stdin }).on("line", (line) => {
  handle(JSON.parse(line) as FixtureMessage);
});
