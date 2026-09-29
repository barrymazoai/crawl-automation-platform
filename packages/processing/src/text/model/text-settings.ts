import {
  CodexModelSettingsSchema,
  TextCompatibilitySchema,
  VersionTagSchema,
  codexSettingsFingerprint,
  labelExtractionVersion,
  labelValidationVersion,
  type CodexModelSettings,
  type TextCompatibility,
} from "@crawl-automation/v3-contracts";
import {
  labelTextInstructions,
  labelTextOutputSchema,
  labelTextPolicyVersion,
} from "../protocol/label-instructions.js";
import { hashText } from "../results/text-record.js";

/** Model settings from the private environment; never guessed, never a silent default model. */
export function readCodexModelSettings(
  env: Readonly<Record<string, string | undefined>>,
): CodexModelSettings {
  return CodexModelSettingsSchema.parse({
    provider: env["V3_CODEX_MODEL_PROVIDER"],
    model: env["V3_CODEX_MODEL"],
    reasoningEffort: env["V3_CODEX_REASONING_EFFORT"],
  });
}

/**
 * The versions and fingerprint a task must carry to run on this model setup. The label fingerprint covers the
 * instructions and answer format, so any change to them is a new setup that old tasks do not match.
 */
export function codexTextCompatibility(
  settings: CodexModelSettings,
  runtimeProfileVersion: string,
  protocol?: "label-extraction/1",
): TextCompatibility {
  const profile = VersionTagSchema.parse(runtimeProfileVersion);
  const settingsFingerprint = codexSettingsFingerprint(settings, hashText);
  if (protocol === "label-extraction/1") {
    return TextCompatibilitySchema.parse({
      schemaVersion: 1,
      module: "codex.text",
      implementationVersion: "codex-text/3",
      policyVersion: labelTextPolicyVersion,
      resultSchemaVersion: 3,
      configFingerprint: hashText(
        JSON.stringify([
          "codex-label-text-config/1",
          profile,
          settingsFingerprint,
          labelExtractionVersion,
          labelValidationVersion,
          labelTextPolicyVersion,
          labelTextInstructions,
          labelTextOutputSchema,
        ]),
      ),
    });
  }
  return TextCompatibilitySchema.parse({
    schemaVersion: 1,
    module: "codex.text",
    implementationVersion: "codex-text/2",
    policyVersion: "anchored/2",
    resultSchemaVersion: 2,
    configFingerprint: hashText(
      JSON.stringify(["codex-text-config/1", profile, settingsFingerprint]),
    ),
  });
}
