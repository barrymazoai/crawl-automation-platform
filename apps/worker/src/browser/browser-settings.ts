import { DtcSettingsSchema } from "@crawl-automation/channel-dtc";
import { WholeFoodsStoreSchema } from "@crawl-automation/channels-wholefoods";
import { EgoSettingsSchema } from "@crawl-automation/platform";
import { z } from "zod";

/**
 * Local settings for the browser worker on each Mac mini with Ego, serving DTC and Amazon
 * Store-page brands. Whole Foods waits on its fetch test; its store settings are retained here.
 */
export const BrowserSettingsSchema = z.strictObject({
  ego: EgoSettingsSchema,
  dtc: DtcSettingsSchema.default({ sites: [] }),
  wholefoods: WholeFoodsStoreSchema,
  /** Names this browser route in each page's archive record. */
  routeId: z.string().min(1).max(120).default("ego-browser"),
  egressId: z.string().min(1).max(120).default("ego-browser/1"),
});
