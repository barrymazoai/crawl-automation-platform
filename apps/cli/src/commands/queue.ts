import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import type { ApiClient } from "../client.js";
import { print } from "../print.js";

type State = "queued" | "ready" | "running" | "review" | "completed";

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export function registerQueueCommands(program: Command, api: () => ApiClient): void {
  const queue = program.command("queue").description("The product queue");

  queue.command("status").action(async () => print(await api().queue.status.query()));

  queue
    .command("items [state]")
    .description("Items in one state: queued, ready, running, review or completed")
    .option("--limit <n>", "how many", "200")
    .action(async (state: State = "running", options: { limit: string }) => {
      print(await api().queue.items.query({ state, limit: Number(options.limit) }));
    });

  queue
    .command("add <campaignId> <batchesFile>")
    .description("Add products from a JSON file of Amazon link batches")
    .action(async (campaignId: string, file: string) => {
      const batches = (await readJson(file)) as never;
      print(await api().queue.add.mutate({ campaignId, batches }));
    });

  queue
    .command("pause")
    .option("--force", "cancel running products instead of letting them finish")
    .option("--grace <seconds>", "drain time before a forced stop; 0 means never", "900")
    .action(async (options: { force?: boolean; grace: string }) => {
      const input = { force: Boolean(options.force), graceSeconds: Number(options.grace) };
      print(await api().queue.pause.mutate(input));
    });

  queue.command("resume").action(async () => print(await api().queue.resume.mutate()));

  queue
    .command("limits <ready> <running>")
    .description("How many products wait ready and how many run at once")
    .action(async (ready: string, running: string) => {
      print(await api().queue.setLimits.mutate({ ready: Number(ready), running: Number(running) }));
    });

  queue
    .command("requeue <itemIdsFile>")
    .description("Queue completed or Review items again (JSON array of item IDs)")
    .action(async (file: string) => {
      const itemIds = (await readJson(file)) as string[];
      print(await api().queue.requeue.mutate({ itemIds }));
    });
}
