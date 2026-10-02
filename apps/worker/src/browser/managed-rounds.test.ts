import { runInNewContext } from "node:vm";
import { EGO_MARKER, egoErrors } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { ManagedBrowserRounds, targetAbsenceScript } from "./managed-rounds.js";
import { storeRoundScript } from "./store-rounds.js";

function fakeSpace() {
  let closed = false;
  const page = {
    targetId: "owned",
    cdp: vi.fn(async () => ({})),
    close: vi.fn(async () => {
      closed = true;
    }),
  };
  const task = {
    ownership: "agent",
    newPage: vi.fn(async () => page),
    tabs: vi.fn(async () => [{ targetId: "user-tab" }, ...(closed ? [] : [{ targetId: "owned" }])]),
  };
  return { page, task };
}

async function execute(script: string, task: ReturnType<typeof fakeSpace>["task"]) {
  const messages: Record<string, unknown>[] = [];
  await runInNewContext(`(async () => { ${script} })()`, {
    taskSpace: async () => task,
    listTaskSpaces: async () => [{ spaceId: 1, ownership: task.ownership }],
    console: { log: (line: string) => messages.push(JSON.parse(line.slice(EGO_MARKER.length))) },
    setTimeout: (resolve: () => void) => resolve(),
  });
  return messages;
}

describe("Store task-owned page lifecycle", () => {
  it.each([
    "return 42;",
    'throw Object.assign(new Error("failure"), { code: "TEST.FAILURE" });',
    'throw Object.assign(new Error("cancelled"), { name: "AbortError" });',
  ])(
    "closes and verifies exact target on success, failure or cooperative cancellation: %s",
    async (body) => {
      const { page, task } = fakeSpace();
      const result = await execute(storeRoundScript(body, { taskSpaceId: 1 }), task);
      expect(result.at(-1)).toMatchObject({ targetId: "owned", closed: true });
      expect(page.close).toHaveBeenCalledOnce();
      expect(task.tabs).toHaveBeenCalledOnce();
      expect(await task.tabs()).toEqual([{ targetId: "user-tab" }]);
    },
  );

  it("rechecks a lagging tab inventory without issuing another close", async () => {
    const { page, task } = fakeSpace();
    task.tabs.mockResolvedValueOnce([{ targetId: "owned" }, { targetId: "user-tab" }]);
    const result = await execute(storeRoundScript("return 1;", { taskSpaceId: 1 }), task);
    expect(result.at(-1)).toMatchObject({ closed: true });
    expect(task.tabs).toHaveBeenCalledTimes(2);
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("leaves an unconfirmed close pending after bounded checks", async () => {
    const { task } = fakeSpace();
    task.tabs.mockResolvedValue([{ targetId: "owned" }]);
    const result = await execute(storeRoundScript("return 1;", { taskSpaceId: 1 }), task);
    expect(result.at(-1)).toMatchObject({ closed: false });
    expect(task.tabs).toHaveBeenCalledTimes(4);
  });

  it("opens nothing when the user owns the space", async () => {
    const { page, task } = fakeSpace();
    task.ownership = "user";
    const result = await execute(storeRoundScript("return 1;", { taskSpaceId: 1 }), task);
    expect(result).toEqual([{ kind: "stop", reason: "user-control" }]);
    expect(task.newPage).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
  });

  it("does not close or take control when the user takes over during the round", async () => {
    const { page, task } = fakeSpace();
    const result = await execute(
      storeRoundScript('task.ownership = "user"; return 1;', { taskSpaceId: 1 }),
      task,
    );
    expect(result.at(-1)).toMatchObject({ kind: "stop", reason: "user-control" });
    expect(page.close).not.toHaveBeenCalled();
    expect(task.tabs).not.toHaveBeenCalled();
  });

  it("read-only recovery checks never close any tab", async () => {
    const { task, page } = fakeSpace();
    const result = await execute(targetAbsenceScript(1, "owned"), task);
    expect(result.at(-1)).toMatchObject({ closed: false });
    expect(task.tabs).toHaveBeenCalledTimes(4);
    expect(page.close).not.toHaveBeenCalled();
  });
});

function recoverySetup() {
  const original = egoErrors.create("BROWSER.PAGE_CLEANUP_PENDING", {
    details: { opened: ["owned"] },
  });
  const browser = {
    round: vi.fn(async () => {
      throw original;
    }),
    closeTarget: vi.fn(async (_target: string, _signal: AbortSignal) => undefined),
  };
  const absent = vi.fn(async (_target: string, _signal: AbortSignal) => false);
  return { browser, absent, rounds: new ManagedBrowserRounds(browser, absent) };
}

describe("Interrupted Ego Store round recovery", () => {
  it("opens nothing when already cancelled", async () => {
    const { rounds, browser } = recoverySetup();
    await expect(rounds.round("", {}, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(browser.round).not.toHaveBeenCalled();
  });

  it("keeps recovery pending if the exact target is still present after its close", async () => {
    const { rounds, browser, absent } = recoverySetup();
    browser.closeTarget.mockRejectedValue(
      egoErrors.create("BROWSER.PAGE_CLEANUP_PENDING", {
        details: { targetId: "owned" },
      }),
    );
    await expect(rounds.round("", {}, new AbortController().signal)).rejects.toMatchObject({
      code: "BROWSER.PAGE_CLEANUP_PENDING",
    });
    expect(absent).toHaveBeenCalledTimes(2);
    expect(browser.closeTarget).toHaveBeenCalledOnce();
  });
  it("recovers only the exact reported target with a fresh noncancelled signal", async () => {
    const { browser, absent, rounds } = recoverySetup();
    const controller = new AbortController();
    browser.round.mockImplementation(async () => {
      controller.abort();
      throw egoErrors.create("BROWSER.PAGE_CLEANUP_PENDING", { details: { targetId: "owned" } });
    });
    await expect(rounds.round("", {}, controller.signal)).rejects.toMatchObject({
      code: "BROWSER.CANCELLED",
      details: { cleanup: "confirmed" },
    });
    expect(absent).toHaveBeenCalledWith("owned", expect.any(AbortSignal));
    expect(browser.closeTarget).toHaveBeenCalledOnce();
    expect(browser.closeTarget.mock.calls[0]?.[1].aborted).toBe(false);
  });

  it("does not close again when the original close is now visible", async () => {
    const { rounds, browser, absent } = recoverySetup();
    absent.mockResolvedValue(true);
    await expect(rounds.round("", {}, new AbortController().signal)).rejects.toMatchObject({
      code: "BROWSER.UNAVAILABLE",
      details: { cleanup: "confirmed" },
    });
    expect(browser.closeTarget).not.toHaveBeenCalled();
  });

  it("rechecks a lagging recovery close without retrying it", async () => {
    const { rounds, browser, absent } = recoverySetup();
    absent.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    browser.closeTarget.mockRejectedValue(
      egoErrors.create("BROWSER.PAGE_CLEANUP_PENDING", {
        details: { targetId: "owned" },
      }),
    );
    await expect(rounds.round("", {}, new AbortController().signal)).rejects.toMatchObject({
      code: "BROWSER.UNAVAILABLE",
      details: { cleanup: "confirmed" },
    });
    expect(browser.closeTarget).toHaveBeenCalledOnce();
  });

  it.each(["BROWSER.USER_CONTROL", "BROWSER.UNAVAILABLE"] as const)(
    "preserves cleanup pending when recovery hits %s",
    async (code) => {
      const { rounds, browser, absent } = recoverySetup();
      absent.mockRejectedValue(egoErrors.create(code));
      await expect(rounds.round("", {}, new AbortController().signal)).rejects.toMatchObject({
        code: "BROWSER.PAGE_CLEANUP_PENDING",
        details: { userControl: code === "BROWSER.USER_CONTROL" },
      });
      expect(browser.closeTarget).not.toHaveBeenCalled();
    },
  );

  it("does not try recovery on ordinary source failure", async () => {
    const { rounds, browser, absent } = recoverySetup();
    const failure = egoErrors.create("BROWSER.UNAVAILABLE");
    browser.round.mockRejectedValue(failure);
    await expect(rounds.round("", {}, new AbortController().signal)).rejects.toBe(failure);
    expect(absent).not.toHaveBeenCalled();
  });
});
