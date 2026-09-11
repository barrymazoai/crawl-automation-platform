import { Context } from "@temporalio/activity";
import { afterEach, expect, it, vi } from "vitest";
// Unit tests need role/config logic, not the native Temporal worker bootstrap.
import { parseWorkerConfig } from "../../v3-worker-runtime/src/config.js";
import { RoleRegistry } from "../../v3-worker-runtime/src/registry.js";
import { createTextRole } from "./role.js";
import { fixture, signal } from "./testing.fixture.js";
import { labelExecutionFixture } from "./label-execution.fixture.js";
afterEach(() => vi.restoreAllMocks());
const config = (compatibility = "fixture-v1") => parseWorkerConfig({ role: "codex-text", capability: "codex.text", contractVersion: 1, compatibility,
    expectedBuildId: "a".repeat(64), hostId: "fixture", namespace: "default", address: "127.0.0.1:7233", transport: { mode: "local" }, testSession: "test" });
it("the activity rejects automatic attempts beyond one and produces only reference outcomes", async () => {
    const f = fixture();
    const role = createTextRole({ buildId: "a".repeat(64), compatibility: "fixture-v1", testOnly: true,
        prepare: async () => ({ dependencies: f.deps, dispose: async () => { } }) });
    const prepared = await role.prepare(config(), signal());
    if (prepared.kind !== "activity")
        throw Error();
    const context = vi.spyOn(Context, "current").mockReturnValue({ info: { attempt: 2 } } as unknown as Context);
    await expect(prepared.activities.interpretText!(f.input)).rejects.toMatchObject({ nonRetryable: true, type: "TEXT.RETRY_DENIED" });
    expect(f.calls()).toBe(0);
    context.mockReturnValue({ info: { attempt: 1 }, heartbeat: () => { }, cancellationSignal: signal() } as unknown as Context);
    expect(await prepared.activities.interpretText!(f.input)).toMatchObject({ status: "registered" });
    expect(f.calls()).toBe(1);
});
it("a synthetic role cannot register as a business role", () => {
    const f = fixture(), role = createTextRole({ buildId: "a".repeat(64), compatibility: "fixture-v1", testOnly: true,
        prepare: async () => ({ dependencies: f.deps, dispose: async () => { } }) });
    expect(() => new RoleRegistry("business", [role])).toThrow("cross-environment");
});
it("unsafe provider policy rejects startup and disposes prepared resources", async () => {
    const f = fixture(), dispose = vi.fn(async () => { });
    Object.assign(f.provider.policy, { executionRetries: 1 });
    const role = createTextRole({ buildId: "a".repeat(64), compatibility: "fixture-v1", testOnly: true,
        prepare: async () => ({ dependencies: f.deps, dispose }) });
    await expect(role.prepare(config(), signal())).rejects.toThrow("TEXT.PROVIDER_POLICY");
    expect(dispose).toHaveBeenCalledOnce();
});
it("the Worker Activity executes an explicit grouped-label task and returns only durable references", async () => {
    const f = labelExecutionFixture(), interpret = vi.fn(async () => JSON.stringify(f.wire));
    const compatibility = `text-${f.supported.configFingerprint.slice(0, 32)}`;
    const role = createTextRole({ buildId: "a".repeat(64), compatibility, testOnly: true,
        prepare: async () => ({ dependencies: { ...f.deps, provider: { ...f.provider, supported: f.supported, interpret } }, dispose: async () => {} }) });
    const prepared = await role.prepare(config(compatibility), signal());
    if (prepared.kind !== "activity") throw Error();
    vi.spyOn(Context, "current").mockReturnValue({ info: { attempt: 1 }, heartbeat: () => {}, cancellationSignal: signal() } as unknown as Context);
    const first = await prepared.activities.interpretText!(f.input);
    expect(first).toMatchObject({ status: "registered", operationId: f.input.operationId });
    expect(first).not.toHaveProperty("candidate");
    expect(f.registry.data.get(f.input.operationId)?.input.resultSchemaVersion).toBe(3);
    f.local.data.clear(); const writes = f.remote.writes;
    expect(await prepared.activities.interpretText!(f.input)).toEqual(first);
    expect(interpret).toHaveBeenCalledOnce(); expect(f.remote.writes).toBe(writes);
    await prepared.dispose();
});
