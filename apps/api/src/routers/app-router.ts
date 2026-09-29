import { procedure, router } from "../trpc.js";
import { resourcesRouter } from "./resources.js";
import { runsRouter } from "./runs.js";

export const appRouter = router({
  runs: runsRouter,
  resources: resourcesRouter,
  /** Which workers are up, and whether the queue may start new work. */
  fleet: router({ status: procedure.query(({ ctx }) => ctx.fleet.status()) }),
});

/** The API's full type; the CLI imports it to get a typed client. */
export type AppRouter = typeof appRouter;
