import { it, expect } from "vitest";
import { CodexModelSettingsSchema, textFingerprint } from "@crawl-automation/v3-contracts";
import { readCodexModelSettings, codexTextCompatibility } from "./codex-settings.js";
import { hashText } from "./handoff.js";
import { fixture, signal } from "./testing.fixture.js";
const env = { V3_CODEX_MODEL_PROVIDER: "fixture", V3_CODEX_MODEL: "user-selected-model", V3_CODEX_REASONING_EFFORT: "high" };
it("reads explicit settings and preserves the chosen model exactly", () => {
  expect(readCodexModelSettings(env)).toEqual({ provider: "fixture", model: "user-selected-model", reasoningEffort: "high" });
  expect(readCodexModelSettings({ ...env, V3_CODEX_MODEL: "another-model" }).model).toBe("another-model");
});
it.each(["V3_CODEX_MODEL_PROVIDER", "V3_CODEX_MODEL", "V3_CODEX_REASONING_EFFORT"])("requires %s without silent defaults", key => {
  expect(() => readCodexModelSettings({ ...env, [key]: undefined })).toThrow();
  expect(() => readCodexModelSettings({ ...env, [key]: " " })).toThrow();
});
it("strict config refuses secrets/unknown fields rather than mixing them into semantic identity", () => {
  expect(CodexModelSettingsSchema.safeParse({ ...readCodexModelSettings(env), apiKey: "not-a-real-secret" }).success).toBe(false);
});
it("model, effort, provider and runtime profile changes each produce new compatibility", () => {
  const settings = readCodexModelSettings(env), profile = "codex-audit/1", base = codexTextCompatibility(settings, profile);
  const variants = [base, codexTextCompatibility({ ...settings, model: "another-model" }, profile),
    codexTextCompatibility({ ...settings, reasoningEffort: "low" }, profile), codexTextCompatibility({ ...settings, provider: "other" }, profile), codexTextCompatibility(settings, "codex-audit/2")];
  expect(new Set(variants.map(v => v.configFingerprint)).size).toBe(5);
  expect(codexTextCompatibility(readCodexModelSettings({ ...env, IRRELEVANT_PATH: "/tmp/node-2" }), profile)).toEqual(base);
});
it("a Worker configured for another effort rejects the task before any provider call", async () => {
  const f = fixture(), settings = readCodexModelSettings(env);
  const high = codexTextCompatibility(settings, "profile/1"), low = codexTextCompatibility({ ...settings, reasoningEffort: "low" }, "profile/1");
  Object.assign(f.provider, { supported: high });
  const input = { ...f.input, ...low }; input.inputFingerprint = textFingerprint(input, hashText);
  await expect(f.module.run(input, signal())).rejects.toThrow("TEXT.INVALID_INPUT");
  expect(f.calls()).toBe(0); expect(f.remote.writes).toBe(0);
});
