import type { ListingCounts, ListingStateService } from "@crawl-automation/app";
import { describe, expect, it, vi } from "vitest";
import { createHttpApp } from "./server.js";

/** Only the listing-state service is exercised here; the others are never called. */
function appWith(listingStates: Partial<ListingStateService>) {
  const unused = {} as never;
  return createHttpApp({
    runs: unused,
    queue: unused,
    brands: unused,
    reviews: unused,
    products: unused,
    originals: unused,
    history: unused,
    resources: unused,
    fleet: unused,
    listingStates: listingStates as ListingStateService,
    brandScans: unused,
    brandSources: unused,
  });
}

const query = (input: unknown) => `?input=${encodeURIComponent(JSON.stringify(input))}`;

describe("listing state procedures", () => {
  it("counts one channel's sightings", async () => {
    const answer: ListingCounts = {
      channel: "swanson",
      byState: { unlisted: 3, live: 0 },
      byReason: {
        not_found: 2,
        redirected_to_other_product: 1,
        redirected_away: 0,
        identity_conflict: 0,
      },
      undelivered: 3,
    };
    const counts = vi.fn(async () => answer);
    const response = await appWith({ counts }).request(
      `/trpc/listingStates.counts${query({ channel: "swanson" })}`,
    );
    expect(response.status).toBe(200);
    expect(counts).toHaveBeenCalledWith({ channel: "swanson" });
  });

  it("refuses a channel it does not know before any service runs", async () => {
    const list = vi.fn(async () => []);
    const response = await appWith({ list }).request(
      `/trpc/listingStates.list${query({ channel: "walmart" })}`,
    );
    expect(response.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });
});
