import { DtcSettingsSchema } from "@crawl-automation/channel-dtc";
import { WholeFoodsStoreSchema, WHOLE_FOODS_STORE } from "@crawl-automation/channels-wholefoods";
import { EgoSettingsSchema } from "@crawl-automation/platform";
import { z } from "zod";

/**
 * Local settings for the browser worker on each Mac mini with Ego, serving DTC and Amazon
 * Store-page brands and Whole Foods brand searches at the owner-selected store.
 */
export const BrowserSettingsSchema = z.strictObject({
  ego: EgoSettingsSchema,
  dtc: DtcSettingsSchema.default({ sites: [] }),
  wholefoods: WholeFoodsStoreSchema.refine(
    (store) => store.storeId === WHOLE_FOODS_STORE.storeId,
    "Whole Foods scans use store 10259",
  ).default(WHOLE_FOODS_STORE),
  /** Names this browser route in each page's archive record. */
  routeId: z.string().min(1).max(120).default("ego-browser"),
  egressId: z.string().min(1).max(120).default("ego-browser/1"),
});
