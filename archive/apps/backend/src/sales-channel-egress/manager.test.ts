import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SalesChannelEgressManager, type ManagedSalesChannelBrowser } from "./manager.js";
import { SalesChannelEgressState } from "./state.js";
import type { SalesChannelEgressPolicy } from "./types.js";

const policy: SalesChannelEgressPolicy = {
  channel: "gnc",
  pool: "us-residential",
  selector: "GNC出口",
  exits: [
    { id: "texas", proxyName: "美国德州ip" },
    { id: "washington", proxyName: "美国华盛顿ip" },
  ],
  batchSize: 2,
  challengeCooldownMs: 600_000,
  networkFailureCooldownMs: 120_000,
  maxFailureRetries: 2,
};

describe("SalesChannelEgressManager", () => {
  it("restarts an isolated profile after a batch and challenge", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sales-channel-egress-manager-"));
    const state = new SalesChannelEgressState(path.join(directory, "state.sqlite"));
    const selected: Array<{ selector: string; proxyName: string }> = [];
    const started: string[] = [];
    const closed: string[] = [];
    const startBrowser = vi.fn(async (input: { profileRoot: string }) => {
      started.push(input.profileRoot);
      return {
        cdpUrl: `http://127.0.0.1:${9000 + started.length}`,
        health: async () => true,
        close: async () => { closed.push(input.profileRoot); },
      } satisfies ManagedSalesChannelBrowser;
    });
    const manager = new SalesChannelEgressManager({
      state,
      policies: [policy],
      profileRoot: path.join(directory, "profiles"),
      selectProxy: async (input) => { selected.push(input); },
      startBrowser,
    });

    await manager.prepare("gnc");
    const rotation = manager.rotation("gnc");
    rotation.recordProductSuccess();
    expect(rotation.shouldRotateBeforeProduct()).toBe(false);
    rotation.recordProductSuccess();
    expect(rotation.shouldRotateBeforeProduct()).toBe(true);
    await rotation.rotateAfterBatch();
    expect(selected.map((item) => item.proxyName)).toEqual(["美国德州ip", "美国华盛顿ip"]);
    expect(started).toEqual([
      path.join(directory, "profiles", "gnc", "texas"),
      path.join(directory, "profiles", "gnc", "washington"),
    ]);
    expect(closed).toEqual([path.join(directory, "profiles", "gnc", "texas")]);

    await rotation.rotateAfterFailure("challenge");
    expect(selected.at(-1)?.proxyName).toBe("美国德州ip");
    await manager.close();
    state.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
});
