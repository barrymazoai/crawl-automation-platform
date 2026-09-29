import {
  CreateBrandSchema,
  CreateSourceSchema,
  ListSourcesSchema,
  ToggleSourceSchema,
  UpdateBrandSchema,
  UpdateSourceSchema,
} from "@crawl-automation/app";
import { Id, ListQuery } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { procedure, router } from "../trpc.js";

export const brandsRouter = router({
  list: procedure
    .input(ListQuery.optional())
    .query(({ ctx, input }) => ctx.brands.list(ListQuery.parse(input ?? {}))),

  get: procedure
    .input(z.strictObject({ brandId: Id }))
    .query(({ ctx, input }) => ctx.brands.get(input.brandId)),

  create: procedure.input(CreateBrandSchema).mutation(({ ctx, input }) => ctx.brands.create(input)),

  /** Needs the brand's current revision; a stale revision is refused. */
  update: procedure.input(UpdateBrandSchema).mutation(({ ctx, input }) => ctx.brands.update(input)),

  /** A brand's source URLs on each channel. */
  sources: procedure.input(ListSourcesSchema).query(({ ctx, input }) => ctx.brands.sources(input)),

  createSource: procedure
    .input(CreateSourceSchema)
    .mutation(({ ctx, input }) => ctx.brands.createSource(input)),

  updateSource: procedure
    .input(UpdateSourceSchema)
    .mutation(({ ctx, input }) => ctx.brands.updateSource(input)),

  /** Enable or disable a source; only an enabled source can run. */
  toggleSource: procedure
    .input(ToggleSourceSchema)
    .mutation(({ ctx, input }) => ctx.brands.toggleSource(input)),
});
