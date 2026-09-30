import { expect, it } from "vitest";
import { mergeChannelDeployment } from "./merge-channel-deployment.js";
import { DeploymentSchema } from "./deployment-supervisor.js";
const base = { platform: "darwin", host: "mini", root: "/tmp/mini", node: "/node", database: { connectionString: "test", tls: false },
  jobs: [{ id: "brand-web", entry: "/tmp/mini/old.js", env: { V3_BRAND_WEB_CONFIG: "/private/old" } },
    ...Array.from({ length: 60 }, (_, i) => ({ id: `old-${i}`, entry: "/tmp/mini/old.js", env: { V3_WORKER_CONFIG: `/private/old-${i}` } }))],
  resources: [{ resourceId: "browser", capacity: 1, jobs: ["old-0"], minFreeBytes: 0, dependencies: ["backlog"] }],
  dependencyProbes: [{ id: "backlog", kind: "handoff-backlog", roots: [{ root: "/tmp/mini/old", layout: "ocr" }], maxPending: 20, maxOldestSeconds: 3600, maxFiles: 10000 }] };
const channel = () => ({ ...structuredClone(base), jobs: [{ id: "brand-web", entry: "/tmp/mini/new.js", env: {} }, ...Array.from({ length: 29 }, (_, i) => ({ id: `label-${i}`, entry: "/tmp/mini/new.js", env: { V3_WORKER_CONFIG: `/private/new-${i}` } }))],
  resources: [{ ...base.resources[0]!, jobs: ["label-0"] }], dependencyProbes: [{ ...base.dependencyProbes[0]!, roots: [{ root: "/tmp/mini/new", layout: "ocr" }] }] });
const web = { entry: "/tmp/mini/new.js", config: "/private/web" };
it("merges 61 + 29 roles, one web, unchanged old workers and global resource capacity", () => {
  const before = structuredClone(base), next = mergeChannelDeployment(base, channel(), web);
  expect(next.jobs).toHaveLength(90); expect(next.jobs.filter(j => j.id === "brand-web")).toHaveLength(1);
  expect(next.jobs.slice(1, 61)).toEqual(base.jobs.slice(1)); expect(base).toEqual(before);
  expect(next.resources[0]).toMatchObject({ capacity: 1, jobs: ["old-0", "amazon-label-0"] });
  expect(next.dependencyProbes?.[0]).toMatchObject({ roots: [...base.dependencyProbes[0]!.roots, ...channel().dependencyProbes[0]!.roots] });
});
it("rejects changed capacity, controller root, probe thresholds and duplicate job identities", () => {
  const a = channel(); a.resources[0]!.capacity = 2; expect(() => mergeChannelDeployment(base, a, web)).toThrow();
  const b = channel(); b.root = "/other"; expect(() => mergeChannelDeployment(base, b, web)).toThrow();
  const c = channel(); c.dependencyProbes[0]!.maxPending = 30; expect(() => mergeChannelDeployment(base, c, web)).toThrow();
  const d = channel(); d.jobs[1]!.id = "amazon-brand-web"; expect(() => mergeChannelDeployment({ ...base, jobs: [...base.jobs, d.jobs[1]!] }, d, web)).toThrow();
});
it("bounds the expanded role inventory without expanding capacity limits", () => {
  const jobs = Array.from({ length: 129 }, (_, i) => ({ id: `worker-${i}`, entry: "/tmp/mini/old.js", env: {} }));
  expect(DeploymentSchema.safeParse({ ...base, jobs: jobs.slice(0, 128), resources: [] }).success).toBe(true);
  expect(DeploymentSchema.safeParse({ ...base, jobs, resources: [] }).success).toBe(false);
  expect(DeploymentSchema.safeParse({ ...base, resources: [{ ...base.resources[0], capacity: 65 }] }).success).toBe(false);
});
