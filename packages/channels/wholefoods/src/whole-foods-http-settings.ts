import { z } from "zod";
import { WHOLE_FOODS_STORE, WholeFoodsStoreSchema } from "./whole-foods-store.js";

/** The Alameda's catalog context; the API does not echo a verifiable store identity. */
const SearchStoreSchema = WholeFoodsStoreSchema.extend({
  offerListingDiscriminator: z.string().trim().min(1).max(100),
  categoryId: z.string().regex(/^\d{1,20}$/),
});

/** Shared by API routing and the HTTP listing worker; independent of browser scan settings. */
export const WholeFoodsHttpScanSettingsSchema = z.strictObject({
  brandScanMode: z.enum(["http", "browser"]).default("http"),
  store: SearchStoreSchema.default({
    ...WHOLE_FOODS_STORE,
    offerListingDiscriminator: "A0GA",
    categoryId: "18473610011",
  }),
  size: z.number().int().min(1).max(100).default(100),
  maxPages: z.number().int().min(1).max(250).default(250),
  maxEmptyAttempts: z.number().int().min(1).max(10).default(5),
  emptyPauseMs: z.number().int().min(0).max(60_000).default(2_000),
  readPauseMs: z.number().int().min(0).max(300_000).default(60_000),
  canaryText: z.string().trim().min(1).max(200).default("365 by Whole Foods Market"),
});
export type WholeFoodsHttpScanSettings = z.infer<typeof WholeFoodsHttpScanSettingsSchema>;
export const WHOLE_FOODS_HTTP_SCAN_DEFAULTS = WholeFoodsHttpScanSettingsSchema.parse({});
