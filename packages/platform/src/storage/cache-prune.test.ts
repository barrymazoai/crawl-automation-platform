import { mkdtemp, readdir, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneCache } from "./cache-prune.js";

const NOW = new Date("2026-11-15T03:00:00Z");
const HOUR = 3_600_000;
const MAX_AGE = 48 * HOUR;
const old = new Date(NOW.getTime() - MAX_AGE - HOUR);
const fresh = new Date(NOW.getTime() - HOUR);
const sha = (digit: string) => digit.repeat(64);

async function cache() {
  const root = await mkdtemp(join(tmpdir(), "cache-prune-"));
  const put = async (name: string, text: string, at: Date) => {
    await writeFile(join(root, name), text);
    await utimes(join(root, name), at, at);
  };
  return { root, put };
}

const run = (root: string, removeFiles: boolean) =>
  pruneCache(
    { root, maxAgeMs: MAX_AGE, removeFiles },
    { now: () => NOW },
    new AbortController().signal,
  );

describe("pruneCache", () => {
  it("removes copies written before the maximum age and keeps newer ones", async () => {
    const { root, put } = await cache();
    await put(`${sha("a")}.blob`, "old bytes", old);
    await put(`${sha("b")}.blob`, "new", fresh);

    const report = await run(root, true);

    expect(report).toEqual({ files: 2, removed: 1, removedBytes: 9, young: 1, kept: 0 });
    expect(await readdir(root)).toEqual([`${sha("b")}.blob`]);
  });

  it("never touches staging files, other names or folders, however old", async () => {
    const { root, put } = await cache();
    await put(".staging-2b6df518-727f-4b6a-878b-2def10510be6", "unpublished", old);
    await put("notes.txt", "x", old);
    await put(`${sha("c")}.blob.tmp`, "x", old);
    await mkdir(join(root, `${sha("d")}.blob`));

    const report = await run(root, true);

    expect(report).toMatchObject({ files: 0, removed: 0, kept: 4 });
    expect((await readdir(root)).sort()).toHaveLength(4);
  });

  it("only counts in a preview", async () => {
    const { root, put } = await cache();
    await put(`${sha("e")}.blob`, "old", old);

    expect(await run(root, false)).toMatchObject({ removed: 1, removedBytes: 3 });
    expect(await readdir(root)).toEqual([`${sha("e")}.blob`]);
  });

  it("reports nothing for a cache folder that does not exist yet", async () => {
    const { root } = await cache();
    expect(await run(join(root, "missing"), true)).toEqual({
      files: 0,
      removed: 0,
      removedBytes: 0,
      young: 0,
      kept: 0,
    });
  });
});
