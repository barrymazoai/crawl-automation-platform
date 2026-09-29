import {
  AddToQueueSchema,
  PauseQueueSchema,
  QueueItemsQuerySchema,
  QueueLimitsSchema,
  RequeueSchema,
} from "@crawl-automation/app";
import { procedure, router } from "../trpc.js";

export const queueRouter = router({
  /** Mode, limits and item counts by state. */
  status: procedure.query(({ ctx }) => ctx.queue.status()),

  /** Items in one state, most recently changed first. */
  items: procedure
    .input(QueueItemsQuerySchema.optional())
    .query(({ ctx, input }) => ctx.queue.items(QueueItemsQuerySchema.parse(input ?? {}))),

  /** Add a list of products; importing the same list again adds nothing. */
  add: procedure.input(AddToQueueSchema).mutation(({ ctx, input }) => ctx.queue.add(input)),

  /** Drain (let running products finish) or, with `force`, stop them. */
  pause: procedure
    .input(PauseQueueSchema.optional())
    .mutation(({ ctx, input }) => ctx.queue.pause(PauseQueueSchema.parse(input ?? {}))),

  resume: procedure.mutation(({ ctx }) => ctx.queue.resume()),

  /** How many products wait ready and how many run at once. */
  setLimits: procedure
    .input(QueueLimitsSchema)
    .mutation(({ ctx, input }) => ctx.queue.setLimits(input)),

  /** Queue completed or Review products again. */
  requeue: procedure.input(RequeueSchema).mutation(({ ctx, input }) => ctx.queue.requeue(input)),
});
