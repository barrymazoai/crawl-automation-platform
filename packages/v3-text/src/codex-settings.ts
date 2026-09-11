import { CodexModelSettingsSchema, codexSettingsFingerprint, TextCompatibilitySchema, VersionTagSchema, labelExtractionVersion, labelValidationVersion, type CodexModelSettings } from "@crawl-automation/v3-contracts";
import { hashText } from "./handoff.js";
import { labelTextPolicyVersion, labelTextInstructions, labelTextOutputSchema } from "./label-extraction.js";

/** Explicit composition-root input; never reads process.env or silently picks a model. */
export function readCodexModelSettings(env: Readonly<Record<string, string | undefined>>): CodexModelSettings {
  return CodexModelSettingsSchema.parse({ provider: env.V3_CODEX_MODEL_PROVIDER, model: env.V3_CODEX_MODEL, reasoningEffort: env.V3_CODEX_REASONING_EFFORT });
}
/** Task compatibility, not permission to start an unadmitted runtime. */
export function codexTextCompatibility(settings: CodexModelSettings, runtimeProfileVersion: string, protocol?: "label-extraction/1") {
  const profile = VersionTagSchema.parse(runtimeProfileVersion);
  if (protocol === "label-extraction/1") return TextCompatibilitySchema.parse({ schemaVersion: 1, module: "codex.text",
    implementationVersion: "codex-text/3", policyVersion: labelTextPolicyVersion, resultSchemaVersion: 3,
    configFingerprint: hashText(JSON.stringify(["codex-label-text-config/1", profile, codexSettingsFingerprint(settings, hashText),
      labelExtractionVersion, labelValidationVersion, labelTextPolicyVersion, labelTextInstructions, labelTextOutputSchema])) });
  return TextCompatibilitySchema.parse({ schemaVersion: 1, module: "codex.text", implementationVersion: "codex-text/2",
    policyVersion: "anchored/2", resultSchemaVersion: 2,
    configFingerprint: hashText(JSON.stringify(["codex-text-config/1", profile, codexSettingsFingerprint(settings, hashText)])) });
}
