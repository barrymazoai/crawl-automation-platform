#!/usr/bin/env -S npx tsx
import { TRPCClientError } from "@trpc/client";
import { Command } from "commander";
import { createApiClient, type ApiClient } from "./client.js";
import { registerBrandCommands } from "./commands/brands.js";
import { registerQueueCommands } from "./commands/queue.js";
import { registerResourceCommands } from "./commands/resources.js";
import { registerResultCommands } from "./commands/results.js";
import { registerRunCommands } from "./commands/runs.js";

const program = new Command("crawler")
  .description("Command-line client of the crawler API")
  .requiredOption("--api <url>", "API address, e.g. http://<host>:4188", process.env["V3_API_URL"]);

const api = (): ApiClient => createApiClient(program.opts<{ api: string }>().api);
registerRunCommands(program, api);
registerQueueCommands(program, api);
registerBrandCommands(program, api);
registerResultCommands(program, api);
registerResourceCommands(program, api);

/** Shows an API error by its code, so the reason is clear without a stack trace. */
function report(error: unknown): void {
  const app =
    error instanceof TRPCClientError ? (error.data as { app?: unknown } | undefined)?.app : null;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message, ...(app ? { app } : {}) }, null, 2)}\n`);
  process.exitCode = 1;
}

await program.parseAsync().catch(report);
