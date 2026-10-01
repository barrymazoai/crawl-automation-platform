import {
  CreateBrandSchema,
  CancelScansSchema,
  DerivedSourcesSchema,
  CreateSourceSchema,
  ImportSourcesSchema,
  ListSourcesSchema,
  ScanChannelSchema,
  ScanStateSchema,
  ToggleSourceSchema,
  UpdateBrandSchema,
  UpdateSourceSchema,
} from "@crawl-automation/app";
import { Id, ListQuery } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import { procedure, router } from "../trpc.js";

/** Scans a request names; `sourceIds` or a `channel` (all its enabled sources). */
const ScanRequestInput = z.strictObject({
  requestId: z.uuid(),
  sourceIds: z.array(z.uuid()).min(1).max(1_000).optional(),
  channel: ScanChannelSchema.optional(),
});
const ScanListInput = z
  .strictObject({
    channel: ScanChannelSchema.optional(),
    state: ScanStateSchema.optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
  })
  .optional();

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

  /** Sources by brand or channel, with latest scan facts, queue counts and toggle revisions. */
  sources: procedure.input(ListSourcesSchema).query(({ ctx, input }) => ctx.brands.sources(input)),

  createSource: procedure
    .input(CreateSourceSchema)
    .mutation(({ ctx, input }) => ctx.brands.createSource(input)),

  updateSource: procedure
    .input(UpdateSourceSchema)
    .mutation(({ ctx, input }) => ctx.brands.updateSource(input)),

  /** Scans brands: every product each brand lists goes into the shared queue (the runner reads the pages). */
  scan: procedure
    .input(ScanRequestInput)
    .mutation(({ ctx, input }) => ctx.brandScans.request(input)),

  cancelScans: procedure
    .input(CancelScansSchema)
    .mutation(({ ctx, input }) => ctx.brandScans.cancel(input)),

  /** Brand scans, newest first, with what each found. */
  scans: procedure.input(ScanListInput).query(({ ctx, input }) => ctx.brandScans.list(input ?? {})),

  /** One brand scan: what it found (new, known, missing) and what its revisits have shown so far. */
  scanGet: procedure
    .input(z.strictObject({ scanId: z.uuid() }))
    .query(({ ctx, input }) => ctx.brandScans.get(input.scanId)),

  /** Adds a channel's brand directory as disabled sources; loose and missing name matches come back for review. */
  importSources: procedure
    .input(ImportSourcesSchema)
    .mutation(({ ctx, input }) => ctx.brandSources.import(input)),

  /** Adds disabled Whole Foods sources from existing Amazon p_123 brand-filter sources. */
  deriveWholeFoodsSources: procedure
    .input(DerivedSourcesSchema)
    .mutation(({ ctx, input }) => ctx.brandSources.deriveWholeFoods(input)),

  /** Enable or disable a source; only an enabled source can run. */
  toggleSource: procedure
    .input(ToggleSourceSchema)
    .mutation(({ ctx, input }) => ctx.brands.toggleSource(input)),
});
