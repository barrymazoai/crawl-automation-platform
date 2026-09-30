import { procedure, router } from "../trpc.js";
import { brandsRouter } from "./brands.js";
import { evidenceRouter } from "./evidence.js";
import { historyRouter } from "./history.js";
import { listingStatesRouter } from "./listings.js";
import { queueRouter } from "./queue.js";
import { resourcesRouter } from "./resources.js";
import { productsRouter, reviewsRouter } from "./results.js";
import { runsRouter } from "./runs.js";

export const appRouter = router({
  evidence: evidenceRouter,
  runs: runsRouter,
  queue: queueRouter,
  brands: brandsRouter,
  reviews: reviewsRouter,
  products: productsRouter,
  history: historyRouter,
  resources: resourcesRouter,
  listingStates: listingStatesRouter,
  /** Local PM2 jobs and heartbeats, cross-machine Temporal pollers, and OCR health. */
  fleet: router({ status: procedure.query(({ ctx }) => ctx.fleet.status()) }),
});

/** The API's full type; the CLI imports it to get a typed client. */
export type AppRouter = typeof appRouter;
