import { HistoryQuerySchema } from "@crawl-automation/app";
import { procedure, router } from "../trpc.js";

export const historyRouter = router({
  /** A listing's metrics (or formula) points, newest first, by channel and the channel's product ID. */
  list: procedure.input(HistoryQuerySchema).query(({ ctx, input }) => ctx.history.list(input)),
});
