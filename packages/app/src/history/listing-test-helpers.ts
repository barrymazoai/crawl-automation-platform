import type { ChannelAdapter, ProductAddress } from "@crawl-automation/channels-core";
import { vi } from "vitest";

/** A channel port with no fetching or parsing; tests choose the verified product address. */
export function fakeAdapter(changes: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    id: "gnc",
    captureModes: ["http"],
    httpPolicy: { origins: ["https://catalog.example"], maxBytes: 1000, timeoutMs: 100 },
    productAddress: vi.fn((url: string): ProductAddress => ({
      url,
      listingId: "listing",
      variantId: null,
    })),
    parseProduct: vi.fn(() => {
      throw new Error("parsing is outside this unit test");
    }),
    ...changes,
  };
}
