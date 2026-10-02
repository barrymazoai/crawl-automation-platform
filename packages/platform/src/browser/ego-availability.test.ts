import { hostname } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withPermitExecution,
  type PermitExecutionIdentity,
} from "../execution/permit-execution.js";
import { probeEgo } from "./ego-health.js";
import { EgoPages } from "./ego-pages.js";
import { stopEgoRound } from "./ego-stop.js";
import { fakeEgoRuntime } from "./testing/fake-ego.js";

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()));
});
async function fixture() {
  const fake = await fakeEgoRuntime();
  disposals.push(fake.dispose);
  return fake;
}
const signal = () => new AbortController().signal;
const owner = { permitId: "permit-test", workflowId: "workflow", runId: "run" };
function ledger() {
  const identities: PermitExecutionIdentity[] = [];
  const stopped = new Set<string>();
  return {
    identities,
    stopped,
    record: vi.fn(async (_owner, identity: PermitExecutionIdentity) => {
      identities.push(identity);
    }),
    prove: vi.fn(async (_owner, identity: PermitExecutionIdentity) => {
      stopped.add(identity.executionId);
    }),
  };
}

describe("Ego availability without an Ego installation", () => {
  it.each(["down", "missing", "user"] as const)(
    "reports %s without opening or journaling execution, then recovers",
    async (mode) => {
      const fake = await fixture();
      await fake.write({ ...(await fake.read()), mode });
      const journal = ledger();
      expect((await probeEgo(fake.settings, signal())).healthy).toBe(false);
      await expect(
        withPermitExecution({ owner, ledger: journal }, () =>
          new EgoPages(fake.settings).round("return 1;", {}, signal()),
        ),
      ).rejects.toMatchObject({ category: "RUNTIME" });
      expect(journal.record).not.toHaveBeenCalled();
      expect((await fake.read()).tabs).toEqual([]);
      await fake.write({ ...(await fake.read()), mode: "ready" });
      expect(await probeEgo(fake.settings, signal())).toMatchObject({ healthy: true });
    },
  );

  it("disconnects mid-capture, journals pending cleanup and proves the exact round after recovery", async () => {
    const fake = await fixture();
    const userTab = { targetId: "user-page", label: "p1", openedBy: "user" };
    await fake.write({ ...(await fake.read()), tabs: [userTab] });
    const journal = ledger();
    await expect(
      withPermitExecution({ owner, ledger: journal }, () =>
        new EgoPages(fake.settings).round('await page.goto("disconnect");', {}, signal()),
      ),
    ).rejects.toMatchObject({ code: "BROWSER.PAGE_CLEANUP_PENDING", category: "RUNTIME" });
    expect(journal.stopped.size).toBe(1); // Only the CLI has stopped; page and round remain pending.
    expect((await fake.read()).tabs.map((tab) => tab.targetId)).toEqual([
      "user-page",
      "owned-page",
    ]);
    await fake.write({ ...(await fake.read()), mode: "ready" });
    const round = journal.identities.find((item) => item.kind === "browser-round");
    if (!round) {
      throw new Error("missing round intent");
    }
    expect(round.metadata).toMatchObject({ host: hostname() });
    await withPermitExecution({ owner, ledger: journal }, () =>
      stopEgoRound(fake.settings, {
        round,
        targets: journal.identities.filter((item) => item.kind === "browser"),
      }),
    );
    expect(journal.stopped.size).toBe(3);
    expect(await fake.read()).toMatchObject({ tabs: [userTab], closed: ["owned-page"], visits: 1 });
  });

  it("kills a hung CLI and its child even when SIGTERM is ignored", async () => {
    const fake = await fixture();
    await fake.write({ ...(await fake.read()), mode: "hang" });
    const start = Date.now();
    expect(await probeEgo(fake.settings, signal())).toMatchObject({
      healthy: false,
      code: "BROWSER.TIMEOUT",
    });
    expect(Date.now() - start).toBeLessThan(3_000);
    const pid = (await fake.read()).pid;
    if (!pid) {
      throw new Error("missing CLI pid");
    }
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    const childPid = (await fake.read()).childPid;
    if (!childPid) {
      throw new Error("missing CLI child pid");
    }
    await vi.waitFor(() =>
      expect(() => process.kill(childPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" })),
    );
  });

  it("stops on fresh user takeover despite a stale agent handle, without closing any page", async () => {
    const fake = await fixture();
    await expect(
      new EgoPages(fake.settings).round('await page.goto("takeover");', {}, signal()),
    ).rejects.toMatchObject({ code: "BROWSER.USER_CONTROL" });
    expect(await fake.read()).toMatchObject({ mode: "user", closed: [], visits: 1 });
  });

  it("a crashed page is an infrastructure failure and still closes its exact target", async () => {
    const fake = await fixture();
    await expect(
      new EgoPages(fake.settings).round('await page.goto("crash");', {}, signal()),
    ).rejects.toMatchObject({
      code: "BROWSER.UNAVAILABLE",
      category: "RUNTIME",
      details: { failure: { code: "TARGET_CRASHED" } },
    });
    expect(await fake.read()).toMatchObject({ tabs: [], closed: ["owned-page"], visits: 1 });
  });
});

it("an absent CLI executable is an infrastructure health result", async () => {
  const fake = await fixture();
  expect(
    await probeEgo({ ...fake.settings, cliPath: `${fake.settings.cliPath}-missing` }, signal()),
  ).toMatchObject({ healthy: false, code: "BROWSER.UNAVAILABLE" });
});
