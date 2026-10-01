import { UsageWindowSchema } from "@crawl-automation/app";
import { TRPCError } from "@trpc/server";
import { procedure, router } from "../trpc.js";

export const usageRouter = router({
  summary: procedure.input(UsageWindowSchema).query(({ ctx, input }) => {
    if (!ctx.usage) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Usage service is not configured",
      });
    }
    return ctx.usage.summary(input);
  }),
});
