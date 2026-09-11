import { mkdtemp, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { TextLocalStore } from "./files.js";
import { signal } from "./testing.fixture.js";
it("local evidence is immutable, bounded, and survives reopening", async () => {
    const root = await mkdtemp(join(tmpdir(), "v3-text-files-")), store = await TextLocalStore.open(root);
    expect(await store.read("missing/file", 100, signal())).toBeNull();
    expect(await store.create("a/result", Buffer.from("first"), "application/json", signal())).toBe("created");
    expect(await store.create("a/result", Buffer.from("replacement"), "application/json", signal())).toBe("exists");
    const reopened = await TextLocalStore.open(root);
    expect(Buffer.from((await reopened.read("a/result", 5, signal()))!).toString()).toBe("first");
    await expect(store.read("a/result", 4, signal())).rejects.toThrow("TEXT.OUTPUT_LIMIT");
    expect((await stat(join(root, "a/result"))).mode & 0o777).toBe(0o600);
    await expect(store.create("../escape", Buffer.from("bad"), "text/plain", signal())).rejects.toThrow();
});
it("rejects symlink parents before creating any nested directory outside the local root", async () => {
    const root = await mkdtemp(join(tmpdir(), "v3-text-path-")), outside = await mkdtemp(join(tmpdir(), "v3-text-outside-"));
    const store = await TextLocalStore.open(root);
    await symlink(outside, join(root, "escape"));
    await expect(store.create("escape/nested/file", Buffer.from("bad"), "text/plain", signal())).rejects.toThrow("TEXT.LOCAL_CONFIG");
    await expect(stat(join(outside, "nested"))).rejects.toMatchObject({ code: "ENOENT" });
    await symlink(join(outside, "missing"), join(root, "leaf"));
    await expect(store.read("leaf", 10, signal())).rejects.toThrow();
});
