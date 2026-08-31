import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasReadyMarker, listReadyDirectories, publishReadyMarker, readReadyMarker } from "./ready-marker";

describe("ready marker", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), "ready-marker-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("publishes atomically and reads back the payload", async () => {
    const directory = path.join(root, "batch-000001");
    await publishReadyMarker(directory, "capture.ready.json", { batchId: "batch-000001", itemCount: 3 });
    expect(await hasReadyMarker(directory, "capture.ready.json")).toBe(true);
    expect(await readReadyMarker(directory, "capture.ready.json")).toEqual({ batchId: "batch-000001", itemCount: 3 });
  });

  it("refuses to overwrite an existing marker", async () => {
    const directory = path.join(root, "batch-000001");
    await publishReadyMarker(directory, "capture.ready.json", { itemCount: 3 });
    await expect(publishReadyMarker(directory, "capture.ready.json", { itemCount: 4 })).rejects.toThrow("禁止覆盖");
    expect(await readReadyMarker(directory, "capture.ready.json")).toEqual({ itemCount: 3 });
  });

  it("returns null for a missing marker and lists only published directories", async () => {
    expect(await readReadyMarker(path.join(root, "missing"), "capture.ready.json")).toBeNull();
    await publishReadyMarker(path.join(root, "batch-000002"), "capture.ready.json", {});
    await publishReadyMarker(path.join(root, "batch-000001"), "capture.ready.json", {});
    await publishReadyMarker(path.join(root, "batch-000003"), "other.ready.json", {});
    expect(await listReadyDirectories(root, "capture.ready.json")).toEqual([
      path.join(root, "batch-000001"),
      path.join(root, "batch-000002"),
    ]);
    expect(await listReadyDirectories(path.join(root, "nowhere"), "capture.ready.json")).toEqual([]);
  });
});
