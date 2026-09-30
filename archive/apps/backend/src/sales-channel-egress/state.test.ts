import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SalesChannelEgressState } from "./state.js";
import type { SalesChannelEgressPolicy } from "./types.js";

const policy: SalesChannelEgressPolicy = {
  channel: "gnc",
  pool: "us-residential",
  selector: "GNC出口",
  exits: [
    { id: "texas", proxyName: "美国德州ip" },
    { id: "washington", proxyName: "美国华盛顿ip" },
    { id: "los-angeles", proxyName: "美国洛杉矶ip" },
    { id: "redmond", proxyName: "美国雷德蒙德ip" },
  ],
  batchSize: 2,
  challengeCooldownMs: 10 * 60_000,
  networkFailureCooldownMs: 2 * 60_000,
  maxFailureRetries: 4,
};

describe("SalesChannelEgressState", () => {
  it("rotates after a successful batch and persists the cursor", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sales-channel-egress-"));
    const filename = path.join(directory, "state.sqlite");
    const state = new SalesChannelEgressState(filename);
    state.register(policy);
    expect(state.current(policy)?.exit.id).toBe("texas");
    expect(state.recordSuccess(policy, "texas").rotated).toBe(false);
    expect(state.recordSuccess(policy, "texas")).toMatchObject({ rotated: true, currentExit: { id: "washington" } });
    state.close();

    const reopened = new SalesChannelEgressState(filename);
    reopened.register(policy);
    expect(reopened.current(policy)?.exit.id).toBe("washington");
    reopened.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("cools only the challenged channel/exit and skips it", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sales-channel-egress-"));
    const state = new SalesChannelEgressState(path.join(directory, "state.sqlite"));
    const now = new Date("2026-08-31T05:00:00.000Z");
    state.register(policy, now);
    expect(state.recordChallenge(policy, "texas", now)).toMatchObject({
      rotated: true,
      currentExit: { id: "washington" },
      cooldownUntil: "2026-08-31T05:10:00.000Z",
    });
    expect(state.snapshot(policy, new Date("2026-08-31T05:05:00.000Z")).exits[0]).toMatchObject({ id: "texas", available: false });

    const swanson = { ...policy, channel: "swanson", selector: "Swanson出口" };
    state.register(swanson, now);
    expect(state.current(swanson, now)?.exit.id).toBe("texas");
    state.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
});
