import { afterEach, describe, expect, it, vi } from "vitest";

const { loadWorkerConfig } = vi.hoisted(() => ({ loadWorkerConfig: vi.fn() }));
vi.mock("./load-config.js", () => ({ loadWorkerConfig }));
vi.mock("./container.js", () => ({ buildContainer: vi.fn() }));
vi.mock("@crawl-automation/platform/temporal-worker", () => ({ runWorkers: vi.fn() }));
vi.mock("./processes/role-workers.js", () => ({ roleWorkers: vi.fn() }));
vi.mock("./processes/select-process.js", () => ({ selectProcess: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe("Worker startup failure", () => {
  it.each([new Error("startup unavailable"), "invalid startup settings"])(
    "logs %s through the platform logger before exiting",
    async (error) => {
      vi.resetModules();
      loadWorkerConfig.mockRejectedValue(error);
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
        name: "worker",
        level: 60,
        msg: "worker process failed",
        err: String(error),
        time: expect.any(Number),
      });
    },
  );
});
