import { expect, it } from "vitest";
import { readBackAfterWrite } from "./with-cause.js";

it("a failing read-back keeps its own error and carries the write failure as its cause", async () => {
  const write = new Error("upload refused");
  const read = new Error("R2 offline");
  await expect(readBackAfterWrite(() => Promise.reject(read), write)).rejects.toBe(read);
  expect(read.cause).toBe(write);
});

it("never replaces a cause the read error already has, and passes a good read through", async () => {
  const own = new Error("socket reset");
  const read = new Error("R2 offline", { cause: own });
  await expect(
    readBackAfterWrite(() => Promise.reject(read), new Error("upload refused")),
  ).rejects.toBe(read);
  expect(read.cause).toBe(own);
  expect(await readBackAfterWrite(async () => "saved", undefined)).toBe("saved");
});
