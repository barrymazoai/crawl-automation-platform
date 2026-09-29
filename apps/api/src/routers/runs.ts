import { RunFilterSchema, SubmitRunSchema } from "@crawl-automation/app";
import { Id } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { procedure, router } from "../trpc.js";

const RunIdSchema = z.strictObject({ runId: Id });

export const runsRouter = router({
  /** Accept a run. Its workflow starts within seconds. */
  submit: procedure.input(SubmitRunSchema).mutation(({ ctx, input }) => ctx.runs.submit(input)),

  list: procedure
    .input(RunFilterSchema.optional())
    .query(({ ctx, input }) => ctx.runs.list(RunFilterSchema.parse(input ?? {}))),

  /** Progress: catalog pages, products found, workflows by state, permits held. */
  get: procedure.input(RunIdSchema).query(({ ctx, input }) => ctx.runs.get(input.runId)),

  /** Stop every running workflow of the run. */
  cancel: procedure.input(RunIdSchema).mutation(({ ctx, input }) => ctx.runs.cancel(input.runId)),

  /** After a stop: release the run's permits and its source guard. */
  settle: procedure.input(RunIdSchema).mutation(({ ctx, input }) => ctx.runs.settle(input.runId)),
});
