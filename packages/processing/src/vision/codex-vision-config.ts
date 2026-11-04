import { z } from "zod";
import { CodexClientSettingsSchema } from "../codex/codex-settings.js";
import { CodexModelSettingsSchema } from "@crawl-automation/v3-contracts";
import {
  labelIngredientPresenceProtocol,
  labelIngredientPresencePolicySchema,
} from "./protocol/label-ingredient-presence.js";
import { labelTranscriptProtocol } from "./protocol/label-transcript-wire.js";

/** Vision model settings; its own file so the fingerprint can read the type without a cycle. */
export const CodexVisionConfigSchema = CodexClientSettingsSchema.extend({
  extractionProtocol: z.enum(["label-extraction/1", "label-extraction/2"]).optional(),
  /**
   * New wire protocol; the task's normalized candidate format remains label-extraction/1. label-visual-wire/4
   * (owner 2026-11-04) copies the panel and parses it in code, with label-visual-wire/3 as its fallback.
   */
  visualProtocol: z.enum([labelIngredientPresenceProtocol, labelTranscriptProtocol]).optional(),
  ingredientPresencePolicy: labelIngredientPresencePolicySchema.optional(),
  /** Optional independent structural repair turn; absent means enabled with the visual model's settings. */
  repair: z
    .strictObject({
      enabled: z.boolean().default(true),
      settings: CodexModelSettingsSchema.optional(),
    })
    .optional(),
}).refine(
  (config) =>
    (!config.visualProtocol || !!config.extractionProtocol) &&
    (!config.ingredientPresencePolicy || !!config.visualProtocol),
  {
    message: "Ingredient presence requires the versioned label visual protocol",
  },
);
export type CodexVisionConfig = z.infer<typeof CodexVisionConfigSchema>;
