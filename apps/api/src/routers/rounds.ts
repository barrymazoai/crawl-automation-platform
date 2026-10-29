import { RoundQuerySchema } from "@crawl-automation/app";
import { TRPCError } from "@trpc/server";
import { procedure, router } from "../trpc.js";

/** Crawl rounds per channel for Supply Smart's Data updates page (KAN-229); read-only. */
export const roundsRouter = router({
  list: procedure.input(RoundQuerySchema).query(({ ctx, input }) => {
    if (!ctx.rounds) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Round report service is not configured",
      });
    }
    return ctx.rounds.rounds(input);
  }),
});
