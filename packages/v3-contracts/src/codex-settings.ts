import { z } from "zod";
import { Sha256Schema } from "./artifacts.js";

// Protocol 0.153.0 defines ReasoningEffort as a string, not a universal enum.
// Supported values belong to the chosen model's supportedReasoningEfforts list.
export const CodexModelSettingsSchema = z.strictObject({
  provider: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  model: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
  reasoningEffort: z.string().min(1).max(50).regex(/^[a-z][a-z0-9_-]*$/),
});
export type CodexModelSettings = z.infer<typeof CodexModelSettingsSchema>;
export function codexSettingsFingerprint(raw: CodexModelSettings, hash: (s: string) => string) {
  return Sha256Schema.parse(hash(JSON.stringify(["codex-model-settings/1", CodexModelSettingsSchema.parse(raw)])));
}
