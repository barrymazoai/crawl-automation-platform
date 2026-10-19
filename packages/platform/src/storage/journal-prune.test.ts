import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneJournal } from "./journal-prune.js";
import type { ListedObject } from "./r2-objects.js";

const NOW = new Date("2026-10-19T20:00:00Z");
const DAY = 24 * 3_600_000;
const old = new Date(NOW.getTime() - 2 * DAY);

const md5 = (text: string) => createHash("md5").update(text).digest("hex");

async function journal() {
  const root = await mkdtemp(join(tmpdir(), "journal-prune-"));
  const put = async (key: string, text: string, at = old) => {
    const path = join(root, key);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text);
    await link(path, join(path, "..", `.pending-${key.length}-${text.length}`));
    await utimes(path, at, at);
  };
  return { root, put };
}

function remote(objects: Record<string, string>) {
  const listed: string[] = [];
  return {
    listed,
    list: async function* (prefix: string): AsyncGenerator<ListedObject> {
      listed.push(prefix);
      for (const [key, text] of Object.entries(objects)) {
        if (key.startsWith(`${prefix}/`)) {
          yield { key, byteSize: Buffer.byteLength(text), etag: md5(text) };
        }
      }
    },
  };
}

const run = (root: string, store: ReturnType<typeof remote>, removeFiles: boolean) =>
  pruneJournal(
    { root, prefixes: ["v3/amazon-html"], minAgeMs: DAY, removeFiles },
    { remote: store, now: () => NOW },
    new AbortController().signal,
  );

describe("pruneJournal", () => {
  it("removes old copies R2 holds byte for byte, with their staging links and emptied folder", async () => {
    const { root, put } = await journal();
    await put("v3/amazon-html/product-a/original.html", "<html>a</html>");
    await put("v3/amazon-html/product-a/original.json", "{}");
    const store = remote({
      "v3/amazon-html/product-a/original.html": "<html>a</html>",
      "v3/amazon-html/product-a/original.json": "{}",
    });

    const report = await run(root, store, true);

    expect(report).toMatchObject({ files: 2, removed: 2, stagingRemoved: 2, foldersRemoved: 1 });
    expect(report.removedBytes).toBe(16);
    expect(await readdir(join(root, "v3/amazon-html"))).toEqual([]);
  });

  it("keeps young files, files missing from R2 and files R2 holds differently", async () => {
    const { root, put } = await journal();
    await put("v3/amazon-html/product-young/original.html", "new", NOW);
    await put("v3/amazon-html/product-b/original.html", "local");
    await put("v3/amazon-html/product-b/original.json", "{}");
    const store = remote({
      "v3/amazon-html/product-young/original.html": "new",
      "v3/amazon-html/product-b/original.html": "other",
    });

    const report = await run(root, store, true);

    expect(report).toMatchObject({
      files: 3,
      removed: 0,
      young: 1,
      notInR2: 1,
      differs: 1,
      stagingKept: 2,
      foldersRemoved: 0,
    });
    expect(report.examples.notInR2).toEqual(["v3/amazon-html/product-b/original.json"]);
    expect(store.listed).toEqual(["v3/amazon-html/product-b"]);
    expect(await readdir(join(root, "v3/amazon-html/product-b"))).toHaveLength(4);
  });

  it("previews: counts what would go and removes nothing", async () => {
    const { root, put } = await journal();
    await put("v3/amazon-html/product-c/original.html", "c");
    const store = remote({ "v3/amazon-html/product-c/original.html": "c" });

    const report = await run(root, store, false);

    expect(report).toMatchObject({ removeFiles: false, removed: 1, stagingRemoved: 1 });
    expect(await readdir(join(root, "v3/amazon-html/product-c"))).toHaveLength(2);
  });

  it("reports a folder whose listing fails and continues with the rest", async () => {
    const { root, put } = await journal();
    await put("v3/amazon-html/product-d/original.html", "d");
    await put("v3/amazon-html/product-e/original.html", "e");
    const store = remote({ "v3/amazon-html/product-e/original.html": "e" });
    const failing = {
      listed: store.listed,
      list: (prefix: string) => {
        if (prefix.endsWith("product-d")) {
          throw new Error("R2 unavailable");
        }
        return store.list(prefix);
      },
    };

    const report = await run(root, failing, true);

    expect(report).toMatchObject({ folders: 2, removed: 1, failedFolders: 1 });
    expect(report.examples.failed[0]).toContain("product-d");
  });

  it("treats a missing channel folder as empty", async () => {
    const { root } = await journal();
    await expect(run(root, remote({}), true)).resolves.toMatchObject({ folders: 0, files: 0 });
  });
});
