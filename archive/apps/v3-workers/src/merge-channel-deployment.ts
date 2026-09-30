import assert from "node:assert/strict";
import { DeploymentSchema } from "./deployment-supervisor.js";

/** Add independently queued channel roles under the existing resource controller.
 * Existing jobs/configs remain byte-equivalent except the single routed web entry.
 */
export function mergeChannelDeployment(previousRaw: unknown, channelRaw: unknown, web: { entry: string; config: string }) {
  const previous = DeploymentSchema.parse(previousRaw), channel = DeploymentSchema.parse(channelRaw);
  for (const key of ["host", "root", "node", "platform", "database"] as const) assert.deepEqual(channel[key], previous[key]);
  assert.equal(previous.jobs.filter(j => j.id === "brand-web").length, 1);
  assert.equal(channel.jobs.filter(j => j.id === "brand-web").length, 1);
  assert.deepEqual(channel.resources.map(r => r.resourceId).sort(), previous.resources.map(r => r.resourceId).sort());
  const name = (id: string) => id.startsWith("amazon-") ? id : `amazon-${id}`;
  const jobs = [...previous.jobs.map(j => j.id === "brand-web" ? { ...j, entry: web.entry, env: { ...j.env, V3_BRAND_WEB_CONFIG: web.config } } : j),
    ...channel.jobs.filter(j => j.id !== "brand-web").map(j => ({ ...j, id: name(j.id) }))];
  const resources = previous.resources.map(r => {
    const added = channel.resources.find(c => c.resourceId === r.resourceId)!;
    assert.deepEqual({ ...added, jobs: [] }, { ...r, jobs: [] });
    return { ...r, jobs: [...r.jobs, ...added.jobs.map(name)] };
  });
  assert.deepEqual(channel.dependencyProbes?.map(p => p.id).sort(), previous.dependencyProbes?.map(p => p.id).sort());
  const dependencyProbes = previous.dependencyProbes?.map(p => {
    const added = channel.dependencyProbes!.find(c => c.id === p.id)!;
    if (p.kind !== "handoff-backlog") { assert.deepEqual(added, p); return p; }
    assert.equal(added.kind, "handoff-backlog");
    assert.deepEqual({ ...added, roots: [] }, { ...p, roots: [] });
    return { ...p, roots: [...new Map([...p.roots, ...added.roots].map(r => [JSON.stringify(r), r])).values()] };
  });
  return DeploymentSchema.parse({ ...previous, jobs, resources, dependencyProbes });
}
