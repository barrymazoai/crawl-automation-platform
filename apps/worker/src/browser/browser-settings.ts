import { WholeFoodsStoreSchema } from "@crawl-automation/channels-wholefoods";
import { EgoSettingsSchema } from "@crawl-automation/platform";
import { z } from "zod";

/** The browser machine's settings (Server 二): its Ego browser and the Whole Foods store every page is read for. */
export const BrowserSettingsSchema = z.strictObject({
  ego: EgoSettingsSchema,
  wholefoods: WholeFoodsStoreSchema,
  /** Names this browser route in each page's archive record. */
  routeId: z.string().min(1).max(120).default("ego-browser"),
  egressId: z.string().min(1).max(120).default("ego-browser/1"),
});
