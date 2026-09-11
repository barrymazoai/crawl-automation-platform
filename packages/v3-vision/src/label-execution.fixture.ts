import { vi } from "vitest";
import type { VisionRecord, VisionTask } from "@crawl-automation/v3-contracts";
import { gncLabelFixture } from "../../v3-contracts/src/label.fixture.js";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { CodexVisionProvider } from "./provider.js";
import { VisionModule } from "./module.js";
import { VisionHandoff, type VisionRegistry } from "./handoff.js";
import { bytes, selection } from "./testing.fixture.js";

export const labelConfig = { settings: { model: "gpt-5.6-luna", provider: "openai", reasoningEffort: "medium" },
  executable: "/fixture/codex", codexHome: "/fixture/profile", workRoot: "/fixture/work",
  runtimeProfileVersion: "gnclive/1", timeoutMs: 240000, extractionProtocol: "label-extraction/1" };
/** Synthetic model output and in-memory dependencies, never a live quality result. */
export function labelExecutionFixture(raw = JSON.stringify(gncLabelFixture())) {
  const local = new MemoryObjects(), remote = new MemoryObjects(), records = new Map<string, VisionRecord>();
  const configFingerprint = CodexVisionProvider.describe(labelConfig).configFingerprint;
  const task: VisionTask = { input: { operationId: "vision-label-1", selection: selection(), extractionProtocol: "label-extraction/1" }, configFingerprint };
  remote.data.set(task.input.selection.image.objectKey, bytes);
  const provider = { fingerprint: configFingerprint, extractionProtocol: "label-extraction/1" as const, interpret: vi.fn(async () => raw) };
  const registry: VisionRegistry = { read: async id => records.get(id) ?? null, register: vi.fn(async r => { records.set(r.input.operationId, r); }) };
  const verify = vi.fn(async () => {});
  const handoff = new VisionHandoff(local, remote, registry, "test/1", verify);
  const dependencies = { provider, store: remote, localEvidence: local, verifiedOcrText: vi.fn(async () => "Supplement Facts"), resolve: vi.fn(async () => bytes) };
  return { task, local, remote, records, registry, provider, verify, handoff, dependencies, module: new VisionModule(dependencies) };
}
