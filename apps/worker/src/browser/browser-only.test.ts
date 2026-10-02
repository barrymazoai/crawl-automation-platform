import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgoPages } from "@crawl-automation/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerConfigSchema } from "../config.js";
import { buildContainer } from "../container.js";
import { loadWorkerConfig } from "../load-config.js";
import { runProcess } from "../processes/run-process.js";
import { selectProcess } from "../processes/select-process.js";
import { workerResourceKinds } from "../resources/resource-check.js";
import { roleWorkers } from "../processes/role-workers.js";
import type { WorkerParts } from "../container.js";

vi.mock("./browser-recovery-parts.js", () => ({
  runBrowserRecovery: vi.fn(async () => undefined),
}));

const { runWorkers } = vi.hoisted(() => ({ runWorkers: vi.fn() }));
vi.mock("@crawl-automation/platform/temporal-worker", () => ({ runWorkers }));
vi.mock("@crawl-automation/platform", async (original) => {
  const actual = await original<typeof import("@crawl-automation/platform")>();
  return {
    ...actual,
    EgoPages: vi.fn(function (settings: unknown) {
      return new actual.EgoPages(settings);
    }),
  };
});

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function browserConfig(root: string) {
  const fingerprint = "a".repeat(64);
  return {
    database: { connectionString: "postgresql://user:password@db.test:1/none" },
    temporal: {
      address: "temporal.test:7233",
      namespace: "crawler-v3",
      transport: { mode: "insecure" },
    },
    clusterId: "test-cluster",
    processes: {
      browser: {
        roles: [
          {
            role: "browser",
            taskQueue: "v3.browser.server2-ego-space-6",
            maxConcurrentActivities: 1,
          },
        ],
      },
    },
    storage: {
      r2: {
        endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
        bucket: "test-bucket",
        prefix: "tests/v3",
      },
      r2Credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
      journalRoot: join(root, "journal"),
      cacheRoot: join(root, "cache"),
    },
    plan: {
      text: {
        schemaVersion: 1,
        module: "codex.text",
        implementationVersion: "codex-text/2",
        policyVersion: "anchored/2",
        resultSchemaVersion: 2,
        configFingerprint: fingerprint,
      },
      ocr: {
        schemaVersion: 1,
        module: "ocr.file",
        implementationVersion: "multipart-ocr/2",
        policyVersion: "single-call/1",
        resultSchemaVersion: 2,
        configFingerprint: fingerprint,
      },
      visionConfigFingerprint: fingerprint,
    },
    browser: {
      resourceId: "server2-ego-space-6",
      ego: { cliPath: "/test/bin/ego-browser", taskSpaceId: 6 },
      wholefoods: { storeId: "10259", label: "The Alameda", postalCode: "95126" },
    },
    resourceKinds: { "server2-ego-space-6": "browser" },
  };
}

async function load(changes: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "browser-only-config-"));
  directories.push(root);
  const file = join(root, "worker.json");
  await writeFile(file, JSON.stringify({ ...browserConfig(root), ...changes }), { mode: 0o600 });
  return loadWorkerConfig({ V3_PIPELINE_CONFIG: file });
}

describe("browser-only worker startup", () => {
  it("Server 一 polls its own queue and the explicitly enabled legacy queue", () => {
    const raw = browserConfig("/test");
    const config = WorkerConfigSchema.parse({
      ...raw,
      browser: {
        ...raw.browser,
        resourceId: "mini-ego-space-1",
        pollLegacyQueue: true,
        ego: { ...raw.browser.ego, taskSpaceId: 2 },
      },
      resourceKinds: { "mini-ego-space-1": "browser" },
      processes: {
        browser: { roles: [{ role: "browser", taskQueue: "v3.browser.mini-ego-space-1" }] },
      },
    });
    const parts = { config } as WorkerParts;
    const queues = roleWorkers(selectProcess(config, "browser").roles, parts).map(
      (worker) => worker.taskQueue,
    );
    expect(queues).toEqual(["v3.browser.mini-ego-space-1", "v3.browser.wholefoods.v1"]);
  });

  it.each(["v3.browser.wholefoods.v1", "v3.browser.mini-ego-space-1", "pipeline"])(
    "refuses Server 二's role configured for %s",
    (taskQueue) => {
      expect(
        WorkerConfigSchema.safeParse({
          ...browserConfig("/test"),
          processes: { browser: { roles: [{ role: "browser", taskQueue }] } },
        }).success,
      ).toBe(false);
    },
  );

  it.each([{}, { "server2-ego-space-6": "http-lane" }])(
    "refuses an undeclared or non-browser local resource kind: %j",
    (resourceKinds) => {
      expect(
        WorkerConfigSchema.safeParse({ ...browserConfig("/test"), resourceKinds }).success,
      ).toBe(false);
    },
  );

  it.each([
    { "mini-ego-space-1": { taskQueues: ["v3.browser.mini-ego-space-1"] } },
    { "server2-ego-space-6": { taskQueues: ["v3.browser.wholefoods.v1"] } },
  ])("refuses foreign or shared-queue browser health targets: %j", (resources) => {
    expect(
      WorkerConfigSchema.safeParse({
        ...browserConfig("/test"),
        resourceHealth: {
          controller: "local",
          minFreeBytes: 0,
          diskPath: "/tmp",
          resources,
        },
      }).success,
    ).toBe(false);
  });

  it.each([
    [2, "mini-ego-space-1"],
    [6, "server2-ego-space-6"],
  ] as const)(
    "uses local Ego space %i and only polls the browser queue",
    async (taskSpaceId, resourceId) => {
      const config = await load({
        browser: {
          ...browserConfig("/test").browser,
          resourceId,
          ego: { cliPath: "/test/bin/ego-browser", taskSpaceId },
        },
        resourceKinds: { [resourceId]: "browser" },
        processes: {
          browser: {
            roles: [
              {
                role: "browser",
                taskQueue: `v3.browser.${resourceId}`,
                maxConcurrentActivities: 1,
              },
            ],
          },
        },
      });
      expect(config.capture).toBeUndefined();
      expect(config.label).toBeUndefined();
      expect(config.processing).toBeUndefined();
      expect(workerResourceKinds(config)(resourceId)).toBe("browser");
      const container = await buildContainer(config);
      vi.stubEnv("V3_WORKER_HEALTH_FILE", "");
      runWorkers.mockResolvedValue({ done: Promise.resolve(), shutdown: vi.fn() });
      try {
        expect(container.cradle.browser.capture).toBeDefined();
        expect(EgoPages).toHaveBeenCalledWith(config.browser?.ego);
        await runProcess(selectProcess(config, "browser"), container.cradle);
        expect(runWorkers).toHaveBeenCalledWith(config.temporal, [
          expect.objectContaining({
            taskQueue: `v3.browser.${resourceId}`,
            maxConcurrentActivities: 1,
            workflowBundlePath: expect.stringContaining("workflows.cjs"),
            activities: {
              captureBrowserProduct: expect.any(Function),
              scanBrandInBrowser: expect.any(Function),
              readBrandListing: expect.any(Function),
            },
          }),
        ]);
      } finally {
        container.cradle.r2.close();
        await container.cradle.database.close();
      }
    },
  );

  it("still requires Ego settings before starting a browser role", async () => {
    await expect(load({ browser: undefined })).rejects.toMatchObject({
      code: "WORKER.BROWSER_SETTINGS_MISSING",
    });
  });

  it("requires planning for browser product capture even without a pipeline role", async () => {
    await expect(load({ plan: undefined })).rejects.toMatchObject({
      code: "WORKER.ROLE_SETTINGS_MISSING",
      details: { role: "browser", section: "plan" },
    });
  });

  it.each(["capture", "label", "plan"])(
    "validates an optional %s section when present",
    (section) => {
      expect(
        WorkerConfigSchema.safeParse({ ...browserConfig("/test"), [section]: {} }).success,
      ).toBe(false);
    },
  );

  it("does not require capture, label or plan for resources-only processes", async () => {
    const config = await load({
      plan: undefined,
      browser: undefined,
      processes: { resources: { roles: [{ role: "resources", taskQueue: "v3.resources.v1" }] } },
    });
    expect(config.plan).toBeUndefined();
  });

  it.each(["label", "label-ocr", "label-model"])(
    "requires processing for %s at startup",
    async (role) => {
      await expect(
        load({ processes: { executor: { roles: [{ role, taskQueue: "labels" }] } } }),
      ).rejects.toMatchObject({
        code: "WORKER.ROLE_SETTINGS_MISSING",
        details: { role, section: "processing" },
      });
    },
  );

  it.each([
    { processes: { arbitrary: { roles: [{ role: "pipeline", taskQueue: "products" }] } } },
    { processes: undefined, taskQueue: "products" },
  ])("retains pipeline requirements including taskQueue-only configs", async (changes) => {
    await expect(load(changes)).rejects.toMatchObject({
      code: "WORKER.ROLE_SETTINGS_MISSING",
      details: { role: "pipeline", section: "capture" },
    });
  });
});
