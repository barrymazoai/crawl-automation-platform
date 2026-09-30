import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import type { ApiClient } from "../client.js";
import { print } from "../print.js";

type State = "queued" | "ready" | "running" | "review" | "completed";
type Channel = "amazon" | "swanson" | "gnc" | "dtc" | "costco" | "wholefoods";
type OtherChannel = Exclude<Channel, "amazon">;

const CHANNEL_OPTION = [
  "--channel <channel>",
  "amazon, swanson, gnc, dtc, costco or wholefoods",
  "amazon",
] as const;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export function registerQueueCommands(program: Command, api: () => ApiClient): void {
  const queue = program.command("queue").description("Each channel's product queue");
  registerReadCommands(queue, api);
  registerAddCommands(queue, api);
  registerControlCommands(queue, api);
}

function registerReadCommands(queue: Command, api: () => ApiClient): void {
  queue
    .command("status")
    .option(...CHANNEL_OPTION)
    .action(async (options: { channel: Channel }) =>
      print(await api().queue.status.query(options)),
    );

  queue
    .command("items [state]")
    .description("Items in one state: queued, ready, running, review or completed")
    .option(...CHANNEL_OPTION)
    .option("--limit <n>", "how many", "200")
    .action(async (state: State = "running", options: { channel: Channel; limit: string }) => {
      const query = { channel: options.channel, state, limit: Number(options.limit) };
      print(await api().queue.items.query(query));
    });
}

function registerControlCommands(queue: Command, api: () => ApiClient): void {
  queue
    .command("pause")
    .option(...CHANNEL_OPTION)
    .option("--force", "cancel running products instead of letting them finish")
    .option("--grace <seconds>", "drain time before a forced stop; 0 means never", "900")
    .action(async (options: { channel: Channel; force?: boolean; grace: string }) => {
      const { channel, force, grace } = options;
      print(
        await api().queue.pause.mutate({
          channel,
          force: Boolean(force),
          graceSeconds: Number(grace),
        }),
      );
    });

  queue
    .command("resume")
    .option(...CHANNEL_OPTION)
    .action(async (options: { channel: Channel }) =>
      print(await api().queue.resume.mutate(options)),
    );

  queue
    .command("limits <ready> <running>")
    .description("How many products wait ready and how many run at once")
    .option(...CHANNEL_OPTION)
    .action(async (ready: string, running: string, options: { channel: Channel }) => {
      const limits = { channel: options.channel, ready: Number(ready), running: Number(running) };
      print(await api().queue.setLimits.mutate(limits));
    });

  queue
    .command("requeue <itemIdsFile>")
    .description("Queue completed or Review items again (JSON array of item IDs)")
    .option(...CHANNEL_OPTION)
    .action(async (file: string, options: { channel: Channel }) => {
      const itemIds = (await readJson(file)) as string[];
      print(await api().queue.requeue.mutate({ channel: options.channel, itemIds }));
    });
}

function registerAddCommands(queue: Command, api: () => ApiClient): void {
  queue
    .command("add <campaignId> <batchesFile>")
    .description("Add Amazon products from a JSON file of Amazon link batches")
    .action(async (campaignId: string, file: string) => {
      const batches = (await readJson(file)) as never;
      print(await api().queue.add.mutate({ channel: "amazon", campaignId, batches }));
    });

  queue
    .command("add-list <channel> <listFile>")
    .description(
      "Add a product list of any other channel: JSON { batchId, label, products: [{ sourceId, url, listingId, variantId }] }",
    )
    .action(async (channel: OtherChannel, file: string) => {
      const list = (await readJson(file)) as { batchId: string; label: string; products: never };
      print(await api().queue.add.mutate({ channel, ...list }));
    });
}
