import { expect, it, vi } from "vitest";
import { ActivityObjectReads } from "./read-scope.js";
import { RetainedPublication } from "./publication.js";
import type { ObjectStore } from "./ports.js";
const signal = () => new AbortController().signal;
function memory() {
  const objects = new Map<string, Uint8Array>();
  const read = vi.fn(async (key: string) => objects.get(key)?.slice() ?? null);
  const create = vi.fn(async (key: string, bytes: Uint8Array) => {
    if (objects.has(key)) return "exists" as const;
    objects.set(key, bytes.slice()); return "created" as const;
  });
  return { objects, read, create };
}
it("reuses only the current Activity's positive GET and gives each caller isolated bytes", async () => {
  const raw = memory(); raw.objects.set("v3/a.json", Buffer.from("abc"));
  const scope = new ActivityObjectReads(raw), stats = vi.fn();
  await scope.run(async () => {
    (await scope.read("v3/a.json", 3, signal()))![0] = 0;
    expect(Buffer.from((await scope.read("v3/a.json", 3, signal()))!).toString()).toBe("abc");
    await expect(scope.read("v3/a.json", 2, signal())).rejects.toThrow("TOO_LARGE");
    await expect(scope.read("v3/a.json", 0, signal())).rejects.toThrow("TOO_LARGE");
    await expect(scope.read("v3/a.json", 3, AbortSignal.abort())).rejects.toThrow();
  }, stats);
  expect(raw.read).toHaveBeenCalledTimes(1); expect(stats).toHaveBeenCalledWith({ reads: 1, hits: 1 });
  raw.objects.set("v3/a.json", Buffer.from("bad"));
  await scope.run(async () => expect(Buffer.from((await scope.read("v3/a.json", 3, signal()))!).toString()).toBe("bad"));
  expect(raw.read).toHaveBeenCalledTimes(2);
});
it("does not share parallel Activity contexts, failures, missing objects, or claims", async () => {
  const raw = memory(), scope = new ActivityObjectReads(raw);
  raw.objects.set("v3/a.json", Buffer.from("abc"));
  await Promise.all([1, 2].map(() => scope.run(async () => {
    await scope.read("v3/a.json", 3, signal()); await scope.read("v3/a.json", 3, signal());
  })));
  expect(raw.read).toHaveBeenCalledTimes(2);
  await scope.run(async () => {
    expect(await scope.read("v3/new.json", 3, signal())).toBeNull();
    raw.objects.set("v3/new.json", Buffer.from("new"));
    expect(await scope.read("v3/new.json", 3, signal())).not.toBeNull();
    raw.read.mockRejectedValueOnce(Error("unavailable"));
    await expect(scope.read("v3/fail.json", 3, signal())).rejects.toThrow("unavailable");
    expect(await scope.read("v3/fail.json", 3, signal())).toBeNull();
    raw.objects.set("v3/publication-claims/abc.json", Buffer.from("yes"));
    await scope.read("v3/publication-claims/abc.json", 3, signal());
    await scope.read("v3/publication-claims/abc.json", 3, signal());
  });
  expect(raw.read).toHaveBeenCalledTimes(8);
});
it("bounds resident entries and bytes without failing valid reads", async () => {
  const raw = memory(), scope = new ActivityObjectReads(raw, 3, 1);
  raw.objects.set("v3/a.json", Buffer.from("abc")); raw.objects.set("v3/b.json", Buffer.from("def"));
  await scope.run(async () => {
    for (const key of ["a", "b", "b", "a"]) await scope.read(`v3/${key}.json`, 3, signal());
  });
  expect(raw.read).toHaveBeenCalledTimes(3);
});
it("GETs after a PUT and uncertain PUT; never substitutes submitted bytes for durable proof", async () => {
  const raw = memory(), local = memory(), scope = new ActivityObjectReads(raw), publication = new RetainedPublication(local, scope);
  const create = raw.create.getMockImplementation()!;
  raw.create.mockImplementation(async (key, bytes) => {
    await create(key, bytes);
    if (key === "v3/a.json") throw Error("unknown PUT result");
    return "created";
  });
  await scope.run(() => publication.publish("v3/a.json", Buffer.from("abc"), "application/json", signal()));
  expect(raw.read.mock.calls.filter(([key]) => key === "v3/a.json")).toHaveLength(2);
  expect(raw.create.mock.calls.filter(([key]) => key === "v3/a.json")).toHaveLength(1);
  await scope.run(async () => {
    await scope.read("v3/a.json", 3, signal());
    await expect(scope.create("v3/a.json", Buffer.from("def"), "application/json", signal())).rejects.toThrow();
    expect(Buffer.from((await scope.read("v3/a.json", 3, signal()))!).toString()).toBe("abc");
  });
  expect(raw.read.mock.calls.filter(([key]) => key === "v3/a.json")).toHaveLength(4);
});
it("does not hide conflicting publication bytes", async () => {
  const raw = memory(), scope = new ActivityObjectReads(raw), publication = new RetainedPublication(memory(), scope);
  raw.objects.set("v3/a.json", Buffer.from("abc"));
  await scope.run(async () => {
    await scope.read("v3/a.json", 3, signal());
    await expect(publication.publish("v3/a.json", Buffer.from("def"), "application/json", signal())).rejects.toThrow("KEY_CONFLICT");
  });
  expect(raw.create).not.toHaveBeenCalled();
});
it("does not cache a GET racing a create", async () => {
  let unblock!: () => void;
  const waiting = new Promise<void>(r => { unblock = r; });
  let reads = 0;
  const raw: ObjectStore = { read: async () => { reads++; if (reads === 1) await waiting; return Buffer.from("abc"); }, create: async () => "exists" };
  const scope = new ActivityObjectReads(raw);
  await scope.run(async () => {
    const pending = scope.read("v3/a.json", 3, signal());
    await scope.create("v3/a.json", Buffer.from("abc"), "application/json", signal());
    unblock(); await pending; await scope.read("v3/a.json", 3, signal());
  });
  expect(reads).toBe(2);
});
