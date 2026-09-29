import { ListingCountsQuerySchema, ListingQuerySchema } from "@crawl-automation/app";
import { procedure, router } from "../trpc.js";

/**
 * Listing states: what direct revisits saw about known listings (gone, superseded, live). Facts only; the product
 * database decides whether a listing is delisted.
 */
export const listingStatesRouter = router({
  /** Sightings of one channel, newest first; optionally one brand, one listing or one state. */
  list: procedure
    .input(ListingQuerySchema)
    .query(({ ctx, input }) => ctx.listingStates.list(input)),

  /** Sightings per state, and how many are not yet sent to the product database. */
  counts: procedure
    .input(ListingCountsQuerySchema)
    .query(({ ctx, input }) => ctx.listingStates.counts(input)),
});
