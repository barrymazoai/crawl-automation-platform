import { labelExtractionVersion, labelValidationVersion } from "@crawl-automation/v3-contracts";
import { hashString } from "../results/result-record.js";
import type { CodexVisionConfig } from "./codex-vision-config.js";
import {
  labelVisionPolicyVersion,
  labelVisionOutputSchema,
  labelVisionPrompt,
} from "./protocol/label-vision.js";
import { labelVisionOutputV2Schema, labelVisionPromptV2 } from "./protocol/label-vision-v2.js";
import {
  visionOutputSchema,
  visionPrompt,
  visionValidationVersion,
} from "./protocol/legacy-vision.js";
import {
  labelIngredientPresencePolicySchema,
  labelIngredientPresencePrompt,
  labelIngredientPresenceOutputSchema,
} from "./protocol/label-ingredient-presence.js";

/**
 * The fingerprint of a vision setup. It covers the model settings, the prompt and the answer format, so any change is
 * a new setup that old tasks do not match. The same formulas the previous vision client used.
 */
export function visionFingerprint(config: CodexVisionConfig): string {
  const { settings, runtimeProfileVersion, timeoutMs } = config;
  const common = [settings, runtimeProfileVersion, timeoutMs, "original"];
  if (config.visualProtocol) {
    return presenceFingerprint(config, common);
  }
  return historicalFingerprint(config, common);
}

function presenceFingerprint(config: CodexVisionConfig, common: unknown[]): string {
  return hashString(
    JSON.stringify([
      "codex-vision/4",
      ...common,
      config.extractionProtocol,
      config.visualProtocol,
      labelIngredientPresencePolicySchema.parse(config.ingredientPresencePolicy ?? {}),
      labelIngredientPresencePrompt,
      labelIngredientPresenceOutputSchema,
    ]),
  );
}

function historicalFingerprint(config: CodexVisionConfig, common: unknown[]): string {
  const { extractionProtocol } = config;
  if (extractionProtocol === "label-extraction/2") {
    const quality = "label-visual-quality/1";
    return hashString(
      JSON.stringify([
        "codex-vision/3",
        ...common,
        extractionProtocol,
        quality,
        labelVisionPromptV2,
        labelVisionOutputV2Schema,
      ]),
    );
  }
  if (extractionProtocol) {
    const versions = [labelExtractionVersion, labelVisionPolicyVersion, labelValidationVersion];
    return hashString(
      JSON.stringify([
        "codex-vision/2",
        ...common,
        ...versions,
        labelVisionPrompt,
        labelVisionOutputSchema,
      ]),
    );
  }
  return hashString(
    JSON.stringify([
      "codex-vision/1",
      ...common,
      visionPrompt,
      visionOutputSchema,
      visionValidationVersion,
    ]),
  );
}
