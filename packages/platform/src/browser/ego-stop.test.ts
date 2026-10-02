import { beforeEach, expect, it, vi } from "vitest";
import { stopEgoRound } from "./ego-stop.js";
import {
  withPermitExecution,
  type PermitExecutionIdentity,
} from "../execution/permit-execution.js";

const mock = vi.hoisted(() => ({ requireEgo: vi.fn(), close: vi.fn() }));
vi.mock("./ego-health.js", () => ({ requireEgo: mock.requireEgo }));
vi.mock("./ego-cleanup.js", () => ({ closeAndVerifyTarget: mock.close }));
beforeEach(() => vi.resetAllMocks());
const settings = { cliPath: "/test/ego", taskSpaceId: 2, noPageSettleMs: 0 };
const round: PermitExecutionIdentity = {
  kind: "browser-round",
  executionId: "old-round",
  taskSpaceId: 2,
  metadata: { protocol: "ego-single-page/1", host: "host", baseline: ["user-tab"] },
};
const owner = { permitId: "permit-browser", workflowId: "owner", runId: "closed-run" };

it("proves the original no-page round using its retained baseline without closing user tabs", async () => {
  mock.requireEgo.mockResolvedValue({ healthy: true, targets: ["user-tab"] });
  const ledger = { record: vi.fn(), prove: vi.fn() };
  await withPermitExecution({ owner, ledger }, () =>
    stopEgoRound(settings, { round, targets: [] }),
  );
  expect(mock.close).not.toHaveBeenCalled();
  expect(ledger.prove).toHaveBeenCalledWith(
    owner,
    round,
    expect.objectContaining({ kind: "browser-round-ended" }),
  );
});

it("an unknown new tab cannot become proof or be closed by inference", async () => {
  mock.requireEgo.mockResolvedValue({ healthy: true, targets: ["user-tab", "unknown-tab"] });
  const ledger = { record: vi.fn(), prove: vi.fn() };
  await expect(
    withPermitExecution({ owner, ledger }, () => stopEgoRound(settings, { round, targets: [] })),
  ).rejects.toMatchObject({ code: "BROWSER.PAGE_CLEANUP_PENDING" });
  expect(mock.close).not.toHaveBeenCalled();
  expect(ledger.prove).not.toHaveBeenCalled();
});

it("uses exact-target cleanup for recorded pages before proving the round", async () => {
  const target: PermitExecutionIdentity = {
    kind: "browser",
    executionId: "owned-tab",
    taskSpaceId: 2,
  };
  mock.close.mockResolvedValue({ kind: "browser-target-absent" });
  mock.requireEgo.mockResolvedValue({ healthy: true, targets: ["user-tab"] });
  const ledger = { record: vi.fn(), prove: vi.fn() };
  await withPermitExecution({ owner, ledger }, () =>
    stopEgoRound(settings, { round, targets: [target] }),
  );
  expect(mock.close).toHaveBeenCalledExactlyOnceWith(settings, "owned-tab");
  expect(ledger.prove.mock.calls.map((call) => call[1])).toEqual([target, round]);
});
