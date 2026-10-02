import {
  CostcoStoreSchema,
  CostcoScanSettingsSchema,
  COSTCO_STORE,
} from "@crawl-automation/channels-costco";
import { DtcSettingsSchema } from "@crawl-automation/channel-dtc";
import {
  WholeFoodsStoreSchema,
  WHOLE_FOODS_STORE,
  WholeFoodsScanSettingsSchema,
} from "@crawl-automation/channels-wholefoods";
import { EgoSettingsSchema } from "@crawl-automation/platform";
import {
  BROWSER_RESOURCE_SPACES,
  BrowserResourceIdSchema,
} from "@crawl-automation/platform/browser-routing";
import { z } from "zod";

/**
 * Local settings for the browser worker on each Mac mini with Ego, serving DTC and Amazon
 * Store-page brands and Whole Foods brand searches at the owner-selected store.
 */
export const BrowserSettingsSchema = z
  .strictObject({
    /** This machine's exclusive browser resource, distinct from archive routeId / egressId. */
    resourceId: BrowserResourceIdSchema,
    /** Server 一 only, until all histories on the old shared queue have settled. */
    pollLegacyQueue: z.boolean().default(false),
    ego: EgoSettingsSchema,
    costcoScan: CostcoScanSettingsSchema.prefault({}),
    costco: CostcoStoreSchema.refine(
      (store) =>
        store.storeId === COSTCO_STORE.storeId &&
        store.label === COSTCO_STORE.label &&
        store.postalCode === COSTCO_STORE.postalCode,
      "Costco scans verify Southlake warehouse 669 / ZIP 76051",
    ).default(COSTCO_STORE),
    dtc: DtcSettingsSchema.default({ sites: [] }),
    wholefoodsScan: WholeFoodsScanSettingsSchema.prefault({}),
    wholefoods: WholeFoodsStoreSchema.refine(
      (store) => store.storeId === WHOLE_FOODS_STORE.storeId,
      "Whole Foods scans use store 10259",
    ).default(WHOLE_FOODS_STORE),
    /** Names this browser route in each page's archive record. */
    routeId: z.string().min(1).max(120).default("ego-browser"),
    egressId: z.string().min(1).max(120).default("ego-browser/1"),
  })
  .superRefine((settings, context) => {
    if (settings.ego.taskSpaceId !== BROWSER_RESOURCE_SPACES[settings.resourceId]) {
      context.addIssue({
        code: "custom",
        path: ["ego", "taskSpaceId"],
        message: "Ego space does not match browser.resourceId",
      });
    }
    if (settings.pollLegacyQueue && settings.resourceId !== "mini-ego-space-1") {
      context.addIssue({
        code: "custom",
        path: ["pollLegacyQueue"],
        message: "Only mini-ego-space-1 may poll the legacy browser queue",
      });
    }
  });
