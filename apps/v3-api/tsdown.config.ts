import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/server.ts", "src/delivery-server.ts", "src/review-delivery.ts", "src/database-cli.ts"],
  format: "esm",
  // The private workspace contract exports TS source for fresh dev/HMR.
  // Inline it so the built server needs no TypeScript runtime loader.
  noExternal: ["@crawl-automation/v3-contracts", "@crawl-automation/v3-review"],
});
