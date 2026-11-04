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
import {
  labelRereadOutputSchema,
  labelRereadPrompt,
  labelTranscriptOutputSchema,
  labelTranscriptPrompt,
  labelTranscriptProtocol,
} from "./protocol/label-transcript-wire.js";

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
  // The transcript setup also asks its re-read and its label-visual-wire/3 fallback, so both are part of it.
  const transcript =
    config.visualProtocol === labelTranscriptProtocol
      ? [
          labelTranscriptPrompt,
          labelTranscriptOutputSchema,
          labelRereadPrompt(["<row>"]),
          labelRereadOutputSchema,
        ]
      : [];
  return hashString(
    JSON.stringify([
      config.visualProtocol === labelTranscriptProtocol ? "codex-vision/5" : "codex-vision/4",
      ...transcript,
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
