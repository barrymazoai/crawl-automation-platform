import { afterEach, describe, expect, it, vi } from "vitest";

const { loadApiConfig } = vi.hoisted(() => ({ loadApiConfig: vi.fn() }));
vi.mock("./config.js", () => ({ loadApiConfig }));
vi.mock("./container.js", () => ({ buildContainer: vi.fn() }));
vi.mock("./server.js", () => ({ createHttpApp: vi.fn(), listen: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe("API startup failure", () => {
  it.each([new Error("startup unavailable"), "invalid startup settings"])(
    "logs %s through the platform logger before exiting",
    async (error) => {
      vi.resetModules();
      loadApiConfig.mockRejectedValue(error);
      const lines: Record<string, unknown>[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        lines.push(JSON.parse(String(chunk)));
        return true;
      });
      const exit = vi.spyOn(process, "exit").mockReturnValue(undefined as never);

      await import("./main.js");

      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        name: "api",
        level: 60,
        msg: "api failed",
        err: String(error),
        time: expect.any(Number),
      });
    },
  );
});
