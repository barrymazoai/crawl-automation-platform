import { mkdtemp, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalObjectStore } from "./local-object-store.js";

const signal = () => new AbortController().signal;
const bytes = (text: string) => Buffer.from(text);

async function openStore() {
  const root = await mkdtemp(join(tmpdir(), "local-object-store-"));
  return { root, store: await LocalObjectStore.open(root) };
}

describe("LocalObjectStore", () => {
  it("writes a key once, keeps it private, and reads it back after reopening", async () => {
    const { root, store } = await openStore();

    expect(await store.create("a/result", bytes("first"), "text/plain", signal())).toBe("created");
    expect(await store.create("a/result", bytes("other"), "text/plain", signal())).toBe("exists");

    const reopened = await LocalObjectStore.open(root);
    expect(Buffer.from((await reopened.read("a/result", 5, signal())) ?? []).toString()).toBe(
      "first",
    );
    expect((await stat(join(root, "a/result"))).mode & 0o777).toBe(0o600);
  });

  it("a missing key reads as null", async () => {
    const { store } = await openStore();

    expect(await store.read("missing/key", 10, signal())).toBeNull();
  });

  it("refuses to read more than the caller allows, and an impossible limit", async () => {
    const { store } = await openStore();
    await store.create("a/result", bytes("first"), "text/plain", signal());

    await expect(store.read("a/result", 4, signal())).rejects.toMatchObject({
      code: "STORAGE.TOO_LARGE",
    });
    await expect(store.read("a/result", 0, signal())).rejects.toMatchObject({
      code: "STORAGE.INVALID_LIMIT",
    });
  });

  it("refuses keys that would leave the folder", async () => {
    const { store } = await openStore();

    await expect(
      store.create("../escape", bytes("bad"), "text/plain", signal()),
    ).rejects.toMatchObject({
      code: "STORAGE.INVALID_KEY",
    });
  });

  it("refuses a symlinked parent folder before creating anything outside the root", async () => {
    const { root, store } = await openStore();
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await symlink(outside, join(root, "escape"));

    await expect(
      store.create("escape/nested/file", bytes("bad"), "text/plain", signal()),
    ).rejects.toMatchObject({
      code: "STORAGE.LOCAL_CONFIG",
    });
    await expect(stat(join(outside, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a relative root", async () => {
    await expect(LocalObjectStore.open("relative/root")).rejects.toMatchObject({
      code: "STORAGE.LOCAL_CONFIG",
    });
  });
});
