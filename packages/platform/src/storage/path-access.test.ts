import { expect, it, vi } from "vitest";
import { pathAccessible } from "./path-access.js";
const { access, recordRecovery } = vi.hoisted(() => ({ access: vi.fn(), recordRecovery: vi.fn() }));
vi.mock("node:fs/promises", () => ({ access }));
vi.mock("../logger/recovery.js", () => ({ recordRecovery }));

it("ignores expected ENOENT but records EACCES with the exact cause", async () => {
  access.mockRejectedValueOnce(Object.assign(new Error("absent"), { code: "ENOENT" }));
  expect(await pathAccessible("marker")).toBe(false);
  expect(recordRecovery).not.toHaveBeenCalled();
  const failure = Object.assign(new Error("denied"), { code: "EACCES" });
  access.mockRejectedValueOnce(failure);
  expect(await pathAccessible("marker")).toBe(false);
  expect(recordRecovery).toHaveBeenCalledWith(failure, { operation: "file.access" });
  access.mockResolvedValueOnce(undefined);
  expect(await pathAccessible("marker")).toBe(true);
});
