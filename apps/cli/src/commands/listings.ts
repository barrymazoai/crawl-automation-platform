import type { Command } from "commander";
import type { ApiClient } from "../client.js";
import { print } from "../print.js";

type Channel = "amazon" | "swanson" | "gnc" | "dtc" | "costco" | "wholefoods";
type State = "gone" | "superseded" | "live";

interface ListOptions {
  channel: Channel;
  brand?: string;
  listing?: string;
  state?: State;
  limit: string;
}

/** What direct revisits saw about known listings: gone, superseded or live. Facts only; nothing is delisted here. */
export function registerListingCommands(program: Command, api: () => ApiClient): void {
  const listings = program.command("listings").description("Listing states seen by revisits");

  listings
    .command("list")
    .description("Sightings of one channel, newest first")
    .requiredOption("--channel <channel>", "amazon, swanson, gnc, dtc, costco or wholefoods")
    .option("--brand <brandId>", "only this brand")
    .option("--listing <listingId>", "only this listing")
    .option("--state <state>", "gone, superseded or live")
    .option("--limit <count>", "at most this many", "200")
    .action(async (options: ListOptions) => {
      const { channel, brand, listing, state, limit } = options;
      const query = {
        channel,
        limit: Number(limit),
        ...(brand ? { brandId: brand } : {}),
        ...(listing ? { listingId: listing } : {}),
        ...(state ? { state } : {}),
      };
      print(await api().listingStates.list.query(query));
    });

  listings
    .command("counts")
    .description("Sightings per state, and how many are not yet sent to the product database")
    .requiredOption("--channel <channel>", "amazon, swanson, gnc, dtc, costco or wholefoods")
    .option("--brand <brandId>", "only this brand")
    .action(async (options: { channel: Channel; brand?: string }) => {
      const { channel, brand } = options;
      print(
        await api().listingStates.counts.query({ channel, ...(brand ? { brandId: brand } : {}) }),
      );
    });
}
