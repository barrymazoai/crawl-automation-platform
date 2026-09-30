import { amazonAdapter } from "@crawl-automation/channel-amazon";
import { createLogger, type TemporalClient } from "@crawl-automation/platform";
import { describe, expect, it } from "vitest";
import { ApiConfigSchema } from "./config.js";
import { assembleContainer } from "./container.js";
import productionShaped from "./fixtures/api-config.json" with { type: "json" };
import { channelRegistry } from "./resources/channel-registry.js";

describe("API composition root", () => {
  it("builds every registered part without a dependency cycle", () => {
    // Every optional section is present in the fixture, so every part is built.
    const config = ApiConfigSchema.parse(productionShaped);
    const temporal = { client: {}, connection: {} } as unknown as TemporalClient;
    const log = createLogger({ name: "api-test", level: "error" });
    const container = assembleContainer({ config, log, temporal });
    for (const name of Object.keys(container.registrations)) {
      expect(() => container.resolve(name as never), name).not.toThrow();
    }
  });

  it("registers the Amazon adapter for HTTP capture alongside Swanson and GNC", () => {
    const registry = channelRegistry();
    expect(registry.channels()).toEqual(["swanson", "gnc", "amazon", "dtc"]);
    expect(registry.forCapture("amazon", "http")).toBe(amazonAdapter);
    expect(registry.forCapture("dtc", "browser").planning?.channel).toBe("dtc");
    expect(() => registry.forCapture("dtc", "http")).toThrow();
    expect(
      registry.get("amazon").productAddress("https://www.amazon.com/dp/B012345678"),
    ).toMatchObject({ listingId: "B012345678", variantId: null });
  });
});
