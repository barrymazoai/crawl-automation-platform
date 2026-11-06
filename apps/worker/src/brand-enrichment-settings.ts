import { isAbsolute } from "node:path";
import { z } from "zod";
import { BrandEnrichmentWorkflowSettingsSchema } from "@crawl-automation/v3-contracts";

export const BrandEnrichmentSettingsSchema = BrandEnrichmentWorkflowSettingsSchema.safeExtend({
  secretsFile: z.string().refine(isAbsolute, "Must be an absolute path"),
  reviewerModel: z.string().min(1),
  limits: BrandEnrichmentWorkflowSettingsSchema.shape.limits
    .unwrap()
    .extend({
      /** Automatic late-product delivery; zero disables this worker-owned loop. */
      redeliverySweepMinutes: z.number().int().min(0).max(1440).default(15),
      /** Look back from the run's completion time, not its creation time. */
      redeliveryLookbackDays: z.number().int().min(1).default(30),
    })
    .prefault({}),
  /**
   * Owner 2026-10-20 (KAN-220): customer brand requests start within seconds of being submitted, through Supply
   * Smart's long poll, at most `maxLiveRuns` at once; a fallback round every `fallbackMinutes` also claims, and stops
   * request runs still live after `timeoutMinutes` (request failed with reason "Timeout", card to `webhookFile`'s
   * Feishu group). Claims and stops go through the operators' API (`apiUrl`, else `stopSweep.apiUrl`); without
   * either, intake stays manual.
   */
  requestIntake: z
    .strictObject({
      enabled: z.boolean().default(true),
      apiUrl: z.url().optional(),
      maxLiveRuns: z.number().int().min(1).max(20).default(1),
      waitSeconds: z.number().int().min(1).max(25).default(25),
      /** How long to wait before looking again while every slot is taken. */
      busySeconds: z.number().int().min(1).max(600).default(15),
      fallbackMinutes: z.number().int().min(1).max(1440).default(15),
      timeoutMinutes: z.number().int().min(10).max(10_080).default(120),
      webhookFile: z.string().refine(isAbsolute, "Must be an absolute path").optional(),
    })
    .prefault({}),
  /**
   * Marketplace products to Supply Smart (owner 2026-10-12). Zero minutes disables the loop; the first deploy runs a
   * small smoke batch before the limits are raised.
   */
  productSync: z
    .strictObject({
      sweepMinutes: z.number().int().min(0).max(1440).default(0),
      channels: z
        // amazon-in is sent only when named: it goes to the Supply Smart its target names (KAN-243).
        .array(z.enum(["amazon", "amazon-in", "gnc", "swanson", "wholefoods", "costco"]))
        .default(["amazon", "gnc", "swanson", "wholefoods", "costco"]),
      batchLimit: z.number().int().min(1).max(200).default(200),
      maxBatchesPerChannel: z.number().int().min(1).max(50).default(5),
      /**
       * Owner 2026-10-16: new brands are matched and, if unmatched, get their website run automatically each round.
       * Calls go through the API (`apiUrl`, else `stopSweep.apiUrl`); without either the step is skipped.
       */
      brands: z
        .strictObject({
          enabled: z.boolean().default(true),
          apiUrl: z.url().optional(),
          matchLimit: z.number().int().min(1).max(500).default(200),
          /**
           * Website lookups run one per Ego space; a run waits for its permits at most ~5.5 h (400 polls) and gets
           * one automatic attempt, so only a short line of waiting runs is kept.
           */
          maxLiveRuns: z.number().int().min(0).max(100).default(20),
        })
        .prefault({}),
      /**
       * KAN-243 (owner 2026-11-05): a channel sent to another Supply Smart than `secretsFile`'s, named by its own
       * private `.env` (SUPPLY_SMART_* only). amazon-in goes to the test database first; it is never sent without one.
       */
      targets: z
        .partialRecord(
          z.enum(["amazon-in"]),
          z.strictObject({
            secretsFile: z.string().trim().min(1),
            /** Crawler brand ID → domain in that Supply Smart, for brands without a production match. */
            brandDomains: z.record(z.uuid(), z.string().trim().min(3).max(253)).default({}),
          }),
        )
        .default({}),
    })
    .refine((sync) => !sync.channels.includes("amazon-in") || !!sync.targets["amazon-in"], {
      message:
        "amazon-in needs productSync.targets.amazon-in: it is never sent to the production Supply Smart",
      path: ["targets"],
    })
    .prefault({}),
});

export { validateBrandEnrichmentSettings } from "@crawl-automation/app";
export type BrandEnrichmentSettings = z.infer<typeof BrandEnrichmentSettingsSchema>;
