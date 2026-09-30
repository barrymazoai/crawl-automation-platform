import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import type { ApiClient } from "../client.js";
import { print } from "../print.js";

type Channel = "amazon" | "gnc" | "swanson" | "dtc";

export function registerRunCommands(program: Command, api: () => ApiClient): void {
  const runs = program.command("runs").description("Submit, watch and stop runs");
  registerSubmitCommands(runs, api);
  registerWatchCommands(runs, api);
}

function registerSubmitCommands(runs: Command, api: () => ApiClient): void {
  runs
    .command("submit")
    .description("Collect one brand on one channel")
    .requiredOption("--brand <id>", "brand ID")
    .requiredOption("--source <id>", "the brand's source ID on the channel")
    .option("--request <id>", "request ID; repeat the same one to retry safely", randomUUID())
    .action(async (options: { brand: string; source: string; request: string }) => {
      const input = {
        kind: "brand" as const,
        requestId: options.request,
        brandId: options.brand,
        sourceId: options.source,
      };
      print(await api().runs.submit.mutate(input));
    });

  runs
    .command("product")
    .description("Collect one product page; its channel and brand come from the source")
    .requiredOption("--source <id>", "the brand's source ID on the product's channel")
    .requiredOption("--url <url>", "the product page")
    .option("--request <id>", "request ID; repeat the same one to retry safely", randomUUID())
    .action(async (options: { source: string; url: string; request: string }) => {
      const input = {
        kind: "product" as const,
        requestId: options.request,
        sourceId: options.source,
        url: options.url,
      };
      print(await api().runs.submit.mutate(input));
    });
}

function registerWatchCommands(runs: Command, api: () => ApiClient): void {
  runs
    .command("list")
    .description("Recent runs, newest first")
    .option("--channel <channel>", "amazon, gnc, swanson or dtc")
    .option("--active", "only runs that still hold their source")
    .action(async (options: { channel?: Channel; active?: boolean }) => {
      print(await api().runs.list.query({ ...options, limit: 50 }));
    });

  runs
    .command("get <runId>")
    .description("Progress of one run")
    .action(async (runId: string) => print(await api().runs.get.query({ runId })));

  runs
    .command("cancel <runId>")
    .description("Stop every running workflow of a run")
    .action(async (runId: string) => print(await api().runs.cancel.mutate({ runId })));

  runs
    .command("settle <runId>")
    .description("After a stop, release the run's permits and source")
    .action(async (runId: string) => print(await api().runs.settle.mutate({ runId })));
}
