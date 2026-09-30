import type { Command } from "commander";
import type { ApiClient } from "../client.js";
import { print } from "../print.js";

type Channel = "amazon" | "swanson" | "gnc" | "dtc" | "costco" | "wholefoods";
type State = "unlisted" | "live";
type Reason = "not_found" | "redirected_to_other_product" | "redirected_away" | "identity_conflict";

interface ListOptions {
  channel: Channel;
  brand?: string;
  listing?: string;
  state?: State;
  reason?: Reason;
  limit: string;
}

/**
 * What direct revisits saw about known listings: unlisted (with why) or live. Facts only; nothing is delisted here.
 */
export function registerListingCommands(program: Command, api: () => ApiClient): void {
  const listings = program.command("listings").description("Listing states seen by revisits");

  listings
    .command("list")
    .description("Sightings of one channel, newest first")
    .requiredOption("--channel <channel>", "amazon, swanson, gnc, dtc, costco or wholefoods")
    .option("--brand <brandId>", "only this brand")
    .option("--listing <listingId>", "only this listing")
    .option("--state <state>", "unlisted or live")
    .option(
      "--reason <reason>",
      "not_found, redirected_to_other_product, redirected_away or identity_conflict",
    )
    .option("--limit <count>", "at most this many", "200")
    .action(async (options: ListOptions) => {
      const { channel, brand, listing, state, reason, limit } = options;
      const query = {
        channel,
        limit: Number(limit),
        ...(brand ? { brandId: brand } : {}),
        ...(listing ? { listingId: listing } : {}),
        ...(state ? { state } : {}),
        ...(reason ? { reason } : {}),
      };
      print(await api().listingStates.list.query(query));
    });

  listings
    .command("counts")
    .description("Sightings per state and unlisted reason, and how many are not yet sent")
    .requiredOption("--channel <channel>", "amazon, swanson, gnc, dtc, costco or wholefoods")
    .option("--brand <brandId>", "only this brand")
    .action(async (options: { channel: Channel; brand?: string }) => {
      const { channel, brand } = options;
      print(
        await api().listingStates.counts.query({ channel, ...(brand ? { brandId: brand } : {}) }),
      );
    });
}
