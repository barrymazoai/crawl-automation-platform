import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import type { ApiClient } from "../client.js";
import { print } from "../print.js";

type ScanChannel = "swanson" | "gnc" | "dtc" | "costco" | "wholefoods";
type ScanState = "queued" | "running" | "complete" | "partial" | "review";
const CHANNELS = "swanson, gnc, dtc, costco or wholefoods";

/** Brand scans (every product a brand lists goes into the shared queue) and brand-source import. */
export function registerBrandScanCommands(brands: Command, api: () => ApiClient): void {
  brands
    .command("scan [sourceIds...]")
    .description("Scan brands: the named sources, or --channel for all its enabled sources")
    .option("--channel <channel>", CHANNELS)
    .option("--request <uuid>", "repeat an earlier request (starts nothing twice)")
    .action(async (sourceIds: string[], options: { channel?: ScanChannel; request?: string }) => {
      const requestId = options.request ?? randomUUID();
      const named = sourceIds.length > 0 ? { sourceIds } : {};
      const channel = options.channel ? { channel: options.channel } : {};
      print(await api().brands.scan.mutate({ requestId, ...named, ...channel }));
    });

  brands
    .command("scans")
    .description("Brand scans, newest first, with what each found")
    .option("--channel <channel>", CHANNELS)
    .option("--state <state>", "queued, running, complete, partial or review")
    .option("--limit <n>", "how many", "50")
    .action(async (options: { channel?: ScanChannel; state?: ScanState; limit: string }) => {
      const { channel, state } = options;
      print(await api().brands.scans.query({ channel, state, limit: Number(options.limit) }));
    });

  brands
    .command("import-sources <channel> <file>")
    .description("Add a channel's brand directory (JSON list of {name, url}) as disabled sources")
    .action(async (channel: ScanChannel, file: string) => {
      const entries = JSON.parse(await readFile(file, "utf8")) as { name: string; url: string }[];
      print(await api().brands.importSources.mutate({ channel, entries }));
    });
}
