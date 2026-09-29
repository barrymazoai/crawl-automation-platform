import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import type { ApiClient } from "../client.js";
import { print } from "../print.js";

type Channel = "amazon" | "gnc" | "swanson" | "dtc";

export function registerBrandCommands(program: Command, api: () => ApiClient): void {
  const brands = program.command("brands").description("Brands and their source URLs");

  brands
    .command("list")
    .option("--search <text>", "part of the brand name", "")
    .option("--limit <n>", "how many", "25")
    .action(async (options: { search: string; limit: string }) => {
      print(
        await api().brands.list.query({
          q: options.search,
          limit: Number(options.limit),
          offset: 0,
        }),
      );
    });

  brands
    .command("get <brandId>")
    .action(async (brandId: string) => print(await api().brands.get.query({ brandId })));

  registerSourceCommands(brands, api);
}

/** A brand's URLs on each channel: list, add, enable. */
function registerSourceCommands(brands: Command, api: () => ApiClient): void {
  brands.command("sources <brandId>").action(async (brandId: string) => {
    print(await api().brands.sources.query({ brandId, q: "", limit: 100, offset: 0 }));
  });

  brands
    .command("add-source <brandId> <channel> <url>")
    .description("Add a brand's URL on a channel (disabled until enabled)")
    .action(async (brandId: string, channel: Channel, url: string) => {
      const input = { requestId: randomUUID(), brandId, channel, region: "US", url };
      print(await api().brands.createSource.mutate(input));
    });

  brands
    .command("enable-source <brandId> <sourceId> <revision>")
    .action(async (brandId: string, sourceId: string, revision: string) => {
      const input = {
        requestId: randomUUID(),
        brandId,
        sourceId,
        enabled: true,
        revision: Number(revision),
      };
      print(await api().brands.toggleSource.mutate(input));
    });
}
