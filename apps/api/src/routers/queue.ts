import {
  AddToQueueSchema,
  ChannelQueueSchema,
  PauseQueueSchema,
  QueueItemsQuerySchema,
  QueueLimitsSchema,
  RequeueSchema,
  FamilyFormulaQuerySchema,
} from "@crawl-automation/app";
import { procedure, router } from "../trpc.js";

const channelOf = (input: unknown) => ChannelQueueSchema.parse(input ?? {}).channel;

/** Every channel's product queue; a call without a channel is about Amazon's. */
export const queueRouter = router({
  familyOutcomes: procedure
    .input(FamilyFormulaQuerySchema)
    .query(({ ctx, input }) => ctx.queue.familyOutcomes(input)),
  reconcileFamilyOutcomes: procedure
    .input(FamilyFormulaQuerySchema)
    .mutation(({ ctx, input }) => ctx.queue.reconcileFamilyOutcomes(input)),
  /** Read-only counts before or after copying never-started legacy Amazon items into the shared queue. */
  amazonMigrationPreview: procedure.query(({ ctx }) => ctx.queue.amazonMigrationPreview()),

  /** Mode, limits and item counts by state. */
  status: procedure
    .input(ChannelQueueSchema.optional())
    .query(({ ctx, input }) => ctx.queue.status(channelOf(input))),

  /** Items in one state, most recently changed first. */
  items: procedure
    .input(QueueItemsQuerySchema.optional())
    .query(({ ctx, input }) => ctx.queue.items(QueueItemsQuerySchema.parse(input ?? {}))),

  /** Add a product list; adding the same list again adds nothing. */
  add: procedure.input(AddToQueueSchema).mutation(({ ctx, input }) => ctx.queue.add(input)),

  /** Drain (let running products finish) or, with `force`, stop them. */
  pause: procedure
    .input(PauseQueueSchema.optional())
    .mutation(({ ctx, input }) => ctx.queue.pause(PauseQueueSchema.parse(input ?? {}))),

  resume: procedure
    .input(ChannelQueueSchema.optional())
    .mutation(({ ctx, input }) => ctx.queue.resume(channelOf(input))),

  /** How many products wait ready and how many run at once. */
  setLimits: procedure
    .input(QueueLimitsSchema)
    .mutation(({ ctx, input }) => ctx.queue.setLimits(input)),

  /** Queue completed or Review products again. */
  requeue: procedure.input(RequeueSchema).mutation(({ ctx, input }) => ctx.queue.requeue(input)),
});
