import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256, type RetainedPublication } from "@crawl-automation/platform";
import { retainCaptureDirectory } from "./archive.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dtc-archive-")));
  roots.push(root);
  await Promise.all(
    Array.from({ length: 9 }, (_, i) => writeFile(join(root, `${i}.html`), `original-${i}`)),
  );
  return root;
}

it("bounds uploads to four while retaining every original with exact hashes", async () => {
  const root = await fixture();
  let active = 0;
  let maximum = 0;
  const saved = new Map<string, Buffer>();
  const publish = vi.fn(async (key: string, bytes: Buffer) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    saved.set(key, bytes);
    active--;
  });
  const files = await retainCaptureDirectory(
    { publish } as unknown as RetainedPublication,
    { root, prefix: "test" },
    AbortSignal.timeout(5000),
  );
  expect(maximum).toBe(4);
  expect(active).toBe(0);
  expect(files).toHaveLength(9);
  for (const file of files) {
    const original = saved.get(file.objectKey);
    if (!original) {
      throw new Error("Missing retained original");
    }
    expect(file.sha256).toBe(sha256(original));
    expect(file.byteSize).toBe(original.length);
  }
});

it("awaits in-flight uploads and starts no next batch after an uncertain publication", async () => {
  const root = await fixture();
  let finished = 0;
  const publish = vi.fn(async () => {
    const first = publish.mock.calls.length === 1;
    await new Promise((resolve) => setTimeout(resolve, first ? 1 : 10));
    finished++;
    if (first) {
      throw new Error("publication unknown");
    }
  });
  await expect(
    retainCaptureDirectory(
      { publish } as unknown as RetainedPublication,
      { root, prefix: "test" },
      AbortSignal.timeout(5000),
    ),
  ).rejects.toThrow("publication unknown");
  expect(publish).toHaveBeenCalledTimes(4);
  expect(finished).toBe(4);
});
