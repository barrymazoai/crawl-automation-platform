import { appErrors, JournalPruneStartSchema } from "@crawl-automation/app";
import { procedure, router, type ApiContext } from "../trpc.js";

function journalPrune(ctx: Pick<ApiContext, "journalPrune">) {
  if (!ctx.journalPrune) {
    throw appErrors.create("JOURNAL_PRUNE.NOT_CONFIGURED");
  }
  return ctx.journalPrune;
}

/** No authentication; input validation and one application operation per procedure. */
export const storageRouter = router({
  /** Starts one prune of this machine's original-page copies; a preview unless `dryRun: false`. */
  journalPrune: procedure
    .input(JournalPruneStartSchema)
    .mutation(({ ctx, input }) => journalPrune(ctx).start(input)),
  /** The running prune, if any, and the last result. */
  journalPruneStatus: procedure.query(({ ctx }) => journalPrune(ctx).status()),
});
