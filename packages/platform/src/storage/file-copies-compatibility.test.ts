import { mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FileCopies as OldCopies } from "@crawl-automation/v3-artifacts";
import { FileCopies } from "./file-copies.js";
import { evidenceBytes, evidenceRef, testSignal } from "./compatibility-fixture.js";

const versions = [
  { name: "old", copies: OldCopies },
  { name: "platform", copies: FileCopies },
];
const folder = () => mkdtemp(join(tmpdir(), "artifact-compatibility-"));

describe("content-addressed file compatibility", () => {
  it("both versions can reopen the same cache with identical names, modes and bytes", async () => {
    const results = [];
    for (const version of versions) {
      const root = await folder();
      const copies = await version.copies.open(root);
      await copies.retain(evidenceRef(), evidenceBytes, testSignal());
      const path = join(root, `${evidenceRef().sha256}.blob`);
      results.push({
        files: await readdir(root),
        bytes: await readFile(path),
        mode: (await stat(path)).mode & 0o777,
      });
      for (const reader of versions) {
        expect(await (await reader.copies.open(root)).read(evidenceRef(), testSignal())).toEqual(
          evidenceBytes,
        );
      }
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[1]?.mode).toBe(0o600);
  });

  it.each(versions)(
    "$name preserves a corrupt entry and its failed staging evidence",
    async (version) => {
      const root = await folder();
      const copies = await version.copies.open(root);
      const path = join(root, `${evidenceRef().sha256}.blob`);
      await writeFile(path, Buffer.alloc(evidenceBytes.length));
      await expect(copies.retain(evidenceRef(), evidenceBytes, testSignal())).rejects.toMatchObject(
        { code: "ARTIFACT.INTEGRITY" },
      );
      expect(await readFile(path)).toEqual(Buffer.alloc(evidenceBytes.length));
      const files = await readdir(root);
      const staged = files.find((name) => name.startsWith(".staging-"));
      expect(staged).toBeDefined();
      expect(await readFile(join(root, staged ?? "missing"))).toEqual(evidenceBytes);
    },
  );

  it.each(versions)("$name refuses symlinks and invalid limits", async (version) => {
    const root = await folder();
    const target = join(await folder(), "outside.txt");
    await writeFile(target, evidenceBytes);
    await symlink(target, join(root, `${evidenceRef().sha256}.blob`));
    const copies = await version.copies.open(root);
    await expect(copies.read(evidenceRef(), testSignal())).rejects.toMatchObject({
      code: "ARTIFACT.CACHE_UNAVAILABLE",
    });
    await expect(version.copies.open(root, 0)).rejects.toMatchObject({ code: "ARTIFACT.SCOPE" });
    await expect(version.copies.open("relative")).rejects.toMatchObject({ code: "ARTIFACT.SCOPE" });
  });

  it.each(versions)("$name returns null for missing copies and bounds reads", async (version) => {
    const copies = await version.copies.open(await folder(), evidenceBytes.length);
    expect(await copies.read(evidenceRef(), testSignal())).toBeNull();
    await copies.retain(evidenceRef(), evidenceBytes, testSignal());
    const tooLarge = { ...evidenceRef(), byteSize: evidenceBytes.length + 1 };
    await expect(copies.read(tooLarge, testSignal())).rejects.toMatchObject({
      code: "ARTIFACT.TOO_LARGE",
    });
    await expect(copies.read(evidenceRef(), AbortSignal.abort())).rejects.toThrow();
    await copies.retain(evidenceRef(), evidenceBytes, testSignal());
    expect(await copies.read(evidenceRef(), testSignal())).toEqual(evidenceBytes);
  });
});
