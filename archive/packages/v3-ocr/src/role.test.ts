import { Context } from "@temporalio/activity";
import { afterEach, expect, it, vi } from "vitest";
import { createOcrRole } from "./role.js";
import { parseWorkerConfig, RoleRegistry } from "@crawl-automation/v3-worker-runtime";
import { setup, signal } from "./testing.fixture.js";

afterEach(() => vi.restoreAllMocks());
it("rejects a retry attempt even if a caller misconfigured Workflow retry policy", async () => {
  const s = await setup();
  const role = createOcrRole({ buildId: "a".repeat(64), compatibility: "fixture-v1", testOnly: true,
    prepare: async () => ({ dependencies: s.deps, dispose: async () => {} }) });
  const config = parseWorkerConfig({ role: "ocr-file", capability: "ocr.file", contractVersion: 1, compatibility: "fixture-v1",
    expectedBuildId: "a".repeat(64), hostId: "fixture", namespace: "default", address: "127.0.0.1:7233", transport: { mode: "local" }, testSession: "test" });
  const prepared = await role.prepare(config, signal());
  vi.spyOn(Context, "current").mockReturnValue({ info: { attempt: 2 } } as unknown as Context);
  if (prepared.kind !== "activity") throw Error();
  await expect(prepared.activities.ocrFile!(s.input)).rejects.toMatchObject({ nonRetryable: true, type: "OCR.AUTOMATIC_RETRY_DENIED" });
  expect(s.calls()).toBe(0); expect(s.remote.writes).toBe(0);
});
it("test provider role cannot be registered into a business registry", async () => {
  const s = await setup();
  const role = createOcrRole({ buildId: "a".repeat(64), compatibility: "fixture-v1", testOnly: true,
    prepare: async () => ({ dependencies: s.deps, dispose: async () => {} }) });
  expect(() => new RoleRegistry("business", [role])).toThrow("cross-environment");
});
