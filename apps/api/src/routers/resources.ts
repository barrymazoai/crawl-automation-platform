import { z } from "zod";
import { procedure, router } from "../trpc.js";

export const resourcesRouter = router({
  /** Each resource's capacity, units held and health. */
  list: procedure.query(({ ctx }) => ctx.resources.list()),

  /** Permits not yet released, with the workflow that holds each. */
  permits: procedure.query(({ ctx }) => ctx.resources.heldPermits()),

  verifyStop: procedure
    .input(z.strictObject({ permitId: z.string().min(1).max(200) }))
    .mutation(({ ctx, input }) => ctx.resources.verifyStop(input.permitId)),

  verifyStops: procedure
    .input(z.strictObject({}))
    .mutation(({ ctx }) => ctx.resources.verifyStops()),

  /** Release only with exact executor/page stop proof and a closed workflow. */
  releasePermit: procedure
    .input(z.strictObject({ permitId: z.string().min(1).max(200) }))
    .mutation(({ ctx, input }) => ctx.resources.release(input.permitId)),
});
