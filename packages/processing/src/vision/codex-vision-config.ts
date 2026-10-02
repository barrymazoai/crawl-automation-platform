import { z } from "zod";
import { CodexClientSettingsSchema } from "../codex/codex-settings.js";
import {
  labelIngredientPresenceProtocol,
  labelIngredientPresencePolicySchema,
} from "./protocol/label-ingredient-presence.js";

/** Vision model settings; its own file so the fingerprint can read the type without a cycle. */
export const CodexVisionConfigSchema = CodexClientSettingsSchema.extend({
  extractionProtocol: z.enum(["label-extraction/1", "label-extraction/2"]).optional(),
  /** New wire protocol; the task's normalized candidate format remains label-extraction/1. */
  visualProtocol: z.literal(labelIngredientPresenceProtocol).optional(),
  ingredientPresencePolicy: labelIngredientPresencePolicySchema.optional(),
}).refine(
  (config) =>
    (!config.visualProtocol || !!config.extractionProtocol) &&
    (!config.ingredientPresencePolicy || !!config.visualProtocol),
  {
    message: "Ingredient presence requires the versioned label visual protocol",
  },
);
export type CodexVisionConfig = z.infer<typeof CodexVisionConfigSchema>;
