import { execa } from "execa";
import { expect, it } from "vitest";
import { liveMembers, stopCaptureGroup } from "./capture-stop.js";

it("sees a live detached group and proves it gone after stopping it", async () => {
  const child = execa("sleep", ["30"], { detached: true, reject: false });
  const pid = child.pid ?? 0;
  expect(await liveMembers(pid)).toBe(true);
  await stopCaptureGroup(pid);
  await child;
  expect(await liveMembers(pid)).toBe(false);
});
