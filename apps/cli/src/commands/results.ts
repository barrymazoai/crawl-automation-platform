import type { Command } from "commander";
import type { ApiClient } from "../client.js";
import { print } from "../print.js";

export function registerResultCommands(program: Command, api: () => ApiClient): void {
  const reviews = program.command("reviews").description("Products that could not be finished");
  reviews.command("summary").action(async () => print(await api().reviews.summary.query()));
  reviews
    .command("get <reviewId>")
    .action(async (reviewId: string) => print(await api().reviews.get.query({ reviewId })));

  program
    .command("products")
    .description("Collected products, newest first")
    .option("--source <id>", "only this source")
    .option("--before <operationId>", "the previous page's nextCursor")
    .action(async (options: { source?: string; before?: string }) => {
      const input = { limit: 50, sourceId: options.source, before: options.before };
      print(await api().products.list.query(input));
    });
}
