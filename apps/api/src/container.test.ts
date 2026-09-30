import { createLogger, type TemporalClient } from "@crawl-automation/platform";
import { describe, expect, it } from "vitest";
import { ApiConfigSchema } from "./config.js";
import { assembleContainer } from "./container.js";
import productionShaped from "./fixtures/api-config.json" with { type: "json" };

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
});
