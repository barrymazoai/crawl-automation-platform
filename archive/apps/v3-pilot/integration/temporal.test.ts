import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  Worker,
  bundleWorkflowCode,
  type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/common";
import { MockOcr } from "../src/adapters/mock-ocr.js";
import { createWorkerContainer } from "../src/bootstrap/container.js";
import { createActivities } from "../src/runners/activities.js";
import { makeFixture } from "../src/runners/fixture.js";
import {
  QUEUES,
  type Completion,
  type OcrInput,
} from "../src/contracts/index.js";
import type { SingleFilePilot } from "../src/workflows/index.js";

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal({
    server: {
      ip: "127.0.0.1",
      ui: false,
      executable: process.env.V3_TEST_TEMPORAL_CLI
        ? { type: "existing-path", path: process.env.V3_TEST_TEMPORAL_CLI }
        : { type: "cached-download", version: "v1.8.3" },
    },
  });
  bundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(
      new URL("../src/workflows/index.ts", import.meta.url),
    ),
  });
});
afterAll(async () => {
  if (env) await env.teardown();
});

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function withWorkers(
  run: (context: { ocr: MockOcr; root: string }) => Promise<void>,
  hooks: {
    afterOcr?: (input: OcrInput, completion: Completion) => Promise<void>;
    beforeConsume?: () => Promise<void>;
    failOcr?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "crawler-v3-p0-temporal-"));
  const ocr = new MockOcr();
  if (hooks.failOcr)
    ocr.recognize = async () => {
      ocr.submissions++;
      throw new Error("Injected provider response loss");
    };
  // Each role owns its container. Only the explicitly configured local evidence root is shared.
  const containers = [
    createWorkerContainer(root, () => ocr),
    createWorkerContainer(root),
    createWorkerContainer(root),
  ];
  const [ocrContainer, handoffContainer, consumerContainer] = containers;
  if (!ocrContainer || !handoffContainer || !consumerContainer)
    throw new Error("Missing test role");
  const ocrActivities = createActivities(ocrContainer),
    handoffActivities = createActivities(handoffContainer),
    consumerActivities = createActivities(consumerContainer);
  const common = {
    connection: env.nativeConnection,
    shutdownGraceTime: "100 milliseconds",
    shutdownForceTime: "3 seconds",
  };
  const workers: Worker[] = [];
  try {
    workers.push(
      await Worker.create({
        ...common,
        taskQueue: QUEUES.workflow,
        workflowBundle: bundle,
      }),
    );
    workers.push(
      await Worker.create({
        ...common,
        taskQueue: QUEUES.ocr,
        maxConcurrentActivityTaskExecutions: 1,
        maxConcurrentActivityTaskPolls: 1,
        activities: {
          async ocrFile(input: OcrInput) {
            const completion = await ocrActivities.ocrFile(input);
            await hooks.afterOcr?.(input, completion);
            return completion;
          },
        },
      }),
    );
    workers.push(
      await Worker.create({
        ...common,
        taskQueue: QUEUES.handoff,
        activities: {
          verifyOcr: handoffActivities.verifyOcr,
          recordReview: handoffActivities.recordReview,
        },
      }),
    );
    workers.push(
      await Worker.create({
        ...common,
        taskQueue: QUEUES.consume,
        activities: {
          async consumeOcr(input: OcrInput, completion: Completion) {
            await hooks.beforeConsume?.();
            return consumerActivities.consumeOcr(input, completion);
          },
        },
      }),
    );
    const runAll = workers.reduceRight<() => Promise<void>>(
      (next, worker) => () => worker.runUntil(next),
      () => run({ ocr, root }),
    );
    await runAll();
  } finally {
    // runUntil drains each worker before disposing its owned resources.
    await Promise.all(containers.map((container) => container.dispose()));
  }
}

describe("actual local Temporal service / independently polled queues", () => {
  it("runs four separately built worker processes and shuts them down cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "crawler-v3-p0-process-"));
    const children = Object.keys(QUEUES).map((role) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("../dist/worker.js", import.meta.url))],
        {
          env: {
            ...process.env,
            V3_ROLE: role,
            V3_TEMPORAL_ADDRESS: env.address,
            V3_EVIDENCE_ROOT: root,
            V3_CONCURRENCY: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let logs = "";
      const exited = new Promise<number | null>((resolveExit) =>
        child.once("exit", (code) => resolveExit(code)),
      );
      const ready = new Promise<void>((resolveReady, rejectReady) => {
        child.once("error", rejectReady);
        child.once("exit", (code) =>
          rejectReady(new Error(`Worker ${role} exited ${code}: ${logs}`)),
        );
        const collect = (chunk: Buffer) => {
          logs = (logs + chunk.toString()).slice(-8000);
          if (logs.includes('"event":"worker.started"')) resolveReady();
        };
        child.stdout.on("data", collect);
        child.stderr.on("data", collect);
      });
      return { child, ready, exited };
    });
    try {
      await Promise.all(children.map((child) => child.ready));
      const result = await env.client.workflow.execute<typeof SingleFilePilot>(
        "SingleFilePilot",
        {
          taskQueue: QUEUES.workflow,
          workflowId: "p0-process",
          args: [makeFixture("process")],
        },
      );
      expect(result.businessOutcome).toBe("processed");
    } finally {
      for (const { child } of children) child.kill("SIGTERM");
      const force = setTimeout(() => {
        for (const { child } of children)
          if (child.exitCode === null) child.kill("SIGKILL");
      }, 5000);
      try {
        expect(
          await Promise.all(children.map((child) => child.exited)),
        ).toEqual([0, 0, 0, 0]);
      } finally {
        clearTimeout(force);
      }
    }
  });
  it("runs the single-file pipeline and replays history without business calls", async () => {
    await withWorkers(async ({ ocr }) => {
      const input = makeFixture("normal");
      const handle = await env.client.workflow.start<typeof SingleFilePilot>(
        "SingleFilePilot",
        { taskQueue: QUEUES.workflow, workflowId: "p0-normal", args: [input] },
      );
      expect(await handle.result()).toMatchObject({
        businessOutcome: "processed",
        characterCount: expect.any(Number),
      });
      expect(ocr.submissions).toBe(1);
      const history = await handle.fetchHistory();
      await Worker.runReplayHistory({ workflowBundle: bundle }, history);
      expect(ocr.submissions).toBe(1);
    });
  });
  it("rejects incompatible consumer versions before activities or business Review", async () => {
    await withWorkers(async ({ocr,root}) => {
      const input={...makeFixture("incompatible"),implementationVersion:"ocr-unsupported/2"};
      await expect(env.client.workflow.execute<typeof SingleFilePilot>("SingleFilePilot",{
        taskQueue:QUEUES.workflow,workflowId:"p0-incompatible",args:[input],
      })).rejects.toMatchObject({cause:{type:"RUNTIME.INCOMPATIBLE_CONSUMER"}});
      expect(ocr.submissions).toBe(0);
      expect(await readdir(root)).toEqual([]);
    });
  });
  it("loses the OCR completion response and recovers only by reading proof", async () => {
    await withWorkers(
      async ({ ocr }) => {
        const result = await env.client.workflow.execute<
          typeof SingleFilePilot
        >("SingleFilePilot", {
          taskQueue: QUEUES.workflow,
          workflowId: "p0-lost-response",
          args: [makeFixture("lost-response")],
        });
        expect(result.businessOutcome).toBe("processed");
        expect(ocr.submissions).toBe(1);
      },
      {
        afterOcr: async () => {
          throw ApplicationFailure.nonRetryable(
            "Injected response loss after durable local proof",
            "TEST.RESPONSE_LOST",
          );
        },
      },
    );
  });
  it("persists passive Review on an unknown provider outcome without automatic retry", async () => {
    await withWorkers(
      async ({ ocr, root }) => {
        const result = await env.client.workflow.execute<
          typeof SingleFilePilot
        >("SingleFilePilot", {
          taskQueue: QUEUES.workflow,
          workflowId: "p0-provider-unknown",
          args: [makeFixture("provider-unknown")],
        });
        expect(result.businessOutcome).toBe("review");
        if (result.businessOutcome !== "review")
          throw new Error("Expected Review");
        expect(
          JSON.parse(await readFile(join(root, result.reviewKey), "utf8")),
        ).toMatchObject({ automaticRetry: false, executionFact: "unknown" });
        expect(ocr.submissions).toBe(1);
      },
      { failOcr: true },
    );
  });
  it("frees the OCR slot while product A waits for its downstream consumer", async () => {
    const downstreamStarted = gate(),
      downstreamRelease = gate(),
      secondOcrDone = gate();
    try {
      await withWorkers(
        async ({ ocr }) => {
          const first = await env.client.workflow.start<typeof SingleFilePilot>(
            "SingleFilePilot",
            {
              taskQueue: QUEUES.workflow,
              workflowId: "p0-flow-a",
              args: [makeFixture("flow-a")],
            },
          );
          await downstreamStarted.promise;
          const second = await env.client.workflow.start<
            typeof SingleFilePilot
          >("SingleFilePilot", {
            taskQueue: QUEUES.workflow,
            workflowId: "p0-flow-b",
            args: [makeFixture("flow-b")],
          });
          await secondOcrDone.promise;
          expect(ocr.submissions).toBe(2);
          expect((await first.describe()).status.name).toBe("RUNNING");
          downstreamRelease.release();
          expect((await first.result()).businessOutcome).toBe("processed");
          expect((await second.result()).businessOutcome).toBe("processed");
        },
        {
          afterOcr: async (input) => {
            if (input.operationId === "ocr-flow-b") secondOcrDone.release();
          },
          beforeConsume: async () => {
            downstreamStarted.release();
            await downstreamRelease.promise;
          },
        },
      );
    } finally {
      downstreamRelease.release();
    }
  });
});
