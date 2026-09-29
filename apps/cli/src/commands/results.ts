import type { Command } from "commander";
import type { ApiClient } from "../client.js";
import { print } from "../print.js";

interface ReviewFilterOptions {
  code?: string;
  stage?: string;
  category?: string;
  operation?: string;
  limit: string;
}

/** The filter options shared by `reviews list` and `reviews recheck`. */
function withFilter(command: Command): Command {
  return command
    .option("--code <code>", "only this failure code, e.g. TEXT.CITATION_INVALID")
    .option("--stage <stage>", "only this stage, e.g. codex.text")
    .option("--category <category>", "only this category, e.g. PROCESSING")
    .option("--operation <operationId>", "only this operation")
    .option("--limit <n>", "at most this many (1-100)", "25");
}

type ReviewQuery = Extract<Parameters<ApiClient["reviews"]["list"]["query"]>[0], object>;

/** The command-line filter as the API's Review query; the API checks every value. */
function filterOf(options: ReviewFilterOptions) {
  return {
    code: options.code,
    stage: options.stage,
    category: options.category as ReviewQuery["category"],
    operationId: options.operation,
  };
}

function registerReviewCommands(program: Command, api: () => ApiClient): void {
  const reviews = program.command("reviews").description("Products that could not be finished");
  reviews.command("summary").action(async () => print(await api().reviews.summary.query()));
  reviews
    .command("get <reviewId>")
    .action(async (reviewId: string) => print(await api().reviews.get.query({ reviewId })));
  withFilter(reviews.command("list").description("Reviews, newest first")).action(
    async (options: ReviewFilterOptions) =>
      print(await api().reviews.list.query({ ...filterOf(options), limit: Number(options.limit) })),
  );
  reviews
    .command("inspect <reviewId>")
    .description("A Review with its retained evidence checked")
    .action(async (reviewId: string) => print(await api().reviews.inspect.query({ reviewId })));
  reviews
    .command("evidence <reviewId>")
    .description("The full Review record with its evidence files from R2")
    .action(async (reviewId: string) => print(await api().reviews.evidence.query({ reviewId })));
  withFilter(
    reviews
      .command("recheck [reviewId]")
      .description("Whether stored model answers pass today's rules (no model call, no writes)"),
  ).action(async (reviewId: string | undefined, options: ReviewFilterOptions) => {
    const input = reviewId
      ? { reviewId }
      : { filter: filterOf(options), limit: Number(options.limit) };
    print(await api().reviews.recheck.query(input));
  });
}

export function registerResultCommands(program: Command, api: () => ApiClient): void {
  registerReviewCommands(program, api);
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
