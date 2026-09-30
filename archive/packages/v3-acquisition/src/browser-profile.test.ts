import { mkdtemp, readFile, writeFile, lstat, mkdir, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { acquireBrowserProfile } from "./browser-profile.js";
import type { LaneGrant } from "./lane-pool.js";

const grant: LaneGrant = { token: "lease", ownerId: "owner", sessionId: "first", laneId: "gnc-texas",
  route: { routeId: "texas", version: "1", egressId: "texas", mode: "static-proxy", managed: true } };
const proxy = "http://127.0.0.1:17891";
const fixture = () => mkdtemp(join(tmpdir(), "gnc-profiles-test-"));
it("reuses the exact profile across sessions and retains browser data on release", async () => {
  const root = await fixture(), first = await acquireBrowserProfile(root, grant, proxy);
  await writeFile(join(first.path, "test-cookie-marker"), "retained", { mode: 0o600 });
  await first.release(); await first.release();
  const second = await acquireBrowserProfile(root, { ...grant, sessionId: "second", token: "new-lease" }, proxy);
  expect(second.path).toBe(first.path);
  expect(await readFile(join(second.path, "test-cookie-marker"), "utf8")).toBe("retained");
  expect((await lstat(second.path)).mode & 0o077).toBe(0);
  await second.release();
});
it("atomically admits only one concurrent profile owner", async () => {
  const root = await fixture();
  const results = await Promise.allSettled([acquireBrowserProfile(root, grant, proxy), acquireBrowserProfile(root, grant, proxy)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  for (const r of results) if (r.status === "fulfilled") await r.value.release();
});
it("isolates profiles for different exits", async () => {
  const root = await fixture(), texas = await acquireBrowserProfile(root, grant, proxy);
  const washington = await acquireBrowserProfile(root, { ...grant, laneId: "gnc-washington" }, "http://127.0.0.1:17892");
  expect(washington.path).not.toBe(texas.path);
  await texas.release(); await washington.release();
});
it("does not reclaim an abandoned owner by age or process id", async () => {
  const root = await fixture(), lane = join(root, grant.laneId);
  await mkdir(lane, { mode: 0o700 });
  await writeFile(join(lane, "owner.json"), JSON.stringify({ pid: -1, token: "unknown", at: "2000-01-01" }));
  await expect(acquireBrowserProfile(root, grant, proxy)).rejects.toThrow("LANE_STATE");
  expect(JSON.parse(await readFile(join(lane, "owner.json"), "utf8")).token).toBe("unknown");
});
it("rejects a changed exit binding without erasing the original profile", async () => {
  const root = await fixture(), held = await acquireBrowserProfile(root, grant, proxy); await held.release();
  await expect(acquireBrowserProfile(root, grant, "http://127.0.0.1:17892")).rejects.toThrow("LANE_STATE");
  await expect(acquireBrowserProfile(root, { ...grant, route: { ...grant.route, mode: "static-proxy", managed: true, egressId: "changed" } }, proxy)).rejects.toThrow("LANE_STATE");
  const again = await acquireBrowserProfile(root, grant, proxy); await again.release();
});
it("does not adopt a profile with Chrome's existing native lock, even a dangling symlink", async () => {
  const root = await fixture(), held = await acquireBrowserProfile(root, grant, proxy); await held.release();
  await symlink("missing-host-process", join(held.path, "SingletonLock"));
  await expect(acquireBrowserProfile(root, grant, proxy)).rejects.toThrow("LANE_STATE");
  expect((await lstat(join(held.path, "SingletonLock"))).isSymbolicLink()).toBe(true);
});
it("refuses symlink profiles and public directories", async () => {
  const root = await fixture(), lane = join(root, grant.laneId), other = await fixture();
  await mkdir(lane, { mode: 0o700 }); await symlink(other, join(lane, "profile"));
  await expect(acquireBrowserProfile(root, grant, proxy)).rejects.toThrow("LANE_STATE");
  const publicRoot = await fixture(); await chmod(publicRoot, 0o755);
  await expect(acquireBrowserProfile(publicRoot, grant, proxy)).rejects.toThrow("LANE_STATE");
});
it("refuses traversal and relative roots", async () => {
  const root = await fixture();
  await expect(acquireBrowserProfile(root, { ...grant, laneId: "../escape" }, proxy)).rejects.toThrow("LANE_STATE");
  await expect(acquireBrowserProfile("relative", grant, proxy)).rejects.toThrow("LANE_STATE");
});
it("never releases a lock whose ownership has changed", async () => {
  const root = await fixture(), held = await acquireBrowserProfile(root, grant, proxy);
  const lock = join(root, grant.laneId, "owner.json");
  await writeFile(lock, JSON.stringify({ token: "another-owner" }));
  await expect(held.release()).rejects.toThrow("LANE_STATE");
  expect(JSON.parse(await readFile(lock, "utf8")).token).toBe("another-owner");
});
