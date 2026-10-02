import { hostname } from "node:os";
import { beforeEach, expect, it, vi } from "vitest";
import { createLogger, type PermitExecutionIdentity } from "@crawl-automation/platform";
import type { CoreParts } from "../core-parts.js";
import { verifyBrowserStop } from "./verify-browser-stop.js";

const fake = vi.hoisted(() => ({
  held: vi.fn(),
  evidence: vi.fn(),
  prove: vi.fn(),
  stop: vi.fn(),
  close: vi.fn(),
}));
vi.mock("@crawl-automation/adapters", async (original) => ({
  ...(await original<object>()),
  PostgresResourceStore: class {
    findHeld = fake.held;
  },
  PostgresStopVerification: class {
    exclusive<T>(work: () => Promise<T>) {
      return work();
    }
  },
  PostgresPermitExecutions: class {
    prove = fake.prove;
  },
  TemporalWorkflowTree: class {
    stopEvidence = fake.evidence;
  },
}));
vi.mock("@crawl-automation/platform", async (original) => ({
  ...(await original<object>()),
  connectTemporal: async () => ({ client: {}, close: fake.close }),
  stopEgoRound: fake.stop,
}));
const owner = { permitId: "permit-browser", workflowId: "closed-owner", runId: "exact-run" };
const round: PermitExecutionIdentity = {
  kind: "browser-round",
  executionId: "round",
  taskSpaceId: 2,
  metadata: { host: hostname(), protocol: "ego-single-page/1", baseline: ["user-tab"] },
};
const cli: PermitExecutionIdentity = { ...round, kind: "browser-cli", executionId: "round/cli" };
const parts = {
  database: {},
  log: createLogger({ name: "browser-stop-test", level: "fatal" }),
  config: {
    temporal: {},
    browser: { resourceId: "mini-ego-space-1", ego: { taskSpaceId: 2, cliPath: "/test/ego" } },
  },
} as unknown as CoreParts;
const input = { owner, resourceId: "mini-ego-space-1" };

beforeEach(() => {
  vi.resetAllMocks();
  fake.held.mockResolvedValue({
    ...owner,
    resources: ["costco-brand-scan", "mini-ego-space-1"],
    cleanup: {
      executions: [
        { identity: round, stoppedAt: null, proof: null },
        {
          identity: cli,
          stoppedAt: new Date(0).toISOString(),
          proof: { kind: "browser-cli-exited" },
        },
      ],
    },
  });
  fake.evidence.mockResolvedValue({
    workflowId: owner.workflowId,
    status: "COMPLETED",
    closedAt: new Date(0),
    pendingActivities: 0,
  });
});

it("loads the original owner and retained baseline on the correct resource host", async () => {
  await verifyBrowserStop(parts, input);
  expect(fake.evidence).toHaveBeenCalledExactlyOnceWith(owner.workflowId, owner.runId);
  expect(fake.stop).toHaveBeenCalledExactlyOnceWith(parts.config.browser?.ego, {
    round,
    targets: [],
    stoppedTargets: [],
  });
  expect(fake.close).toHaveBeenCalledOnce();
});

it("refuses a different host before any browser commands", async () => {
  await expect(
    verifyBrowserStop(parts, { ...input, resourceId: "server2-ego-space-6" }),
  ).rejects.toMatchObject({ code: "RESOURCE.BROWSER_PERMIT_MISMATCH" });
  expect(fake.stop).not.toHaveBeenCalled();
});

it("refuses an owner still running even on the correct host", async () => {
  fake.evidence.mockResolvedValue({
    workflowId: owner.workflowId,
    status: "RUNNING",
    closedAt: null,
    pendingActivities: 0,
  });
  await expect(verifyBrowserStop(parts, input)).rejects.toMatchObject({
    code: "PERMIT.OWNER_RUNNING",
  });
  expect(fake.stop).not.toHaveBeenCalled();
  expect(fake.close).toHaveBeenCalledOnce();
});

it("cannot infer a CLI exit merely from the closed workflow", async () => {
  fake.held.mockResolvedValue({
    ...owner,
    resources: ["mini-ego-space-1"],
    cleanup: {
      executions: [
        { identity: round, stoppedAt: null, proof: null },
        { identity: cli, stoppedAt: null, proof: null },
      ],
    },
  });
  await verifyBrowserStop(parts, input);
  expect(fake.stop).not.toHaveBeenCalled();
});
