import { describe, expect, it, vi } from "vitest";
import { SwansonEgressRotation } from "./egress.js";

const makeSelector = () => {
  const calls: [string, string][] = [];
  return { calls, selector: { select: vi.fn(async (g: string, p: string) => { calls.push([g, p]); }) } as any };
};
const exits = ["a", "b", "c"];

describe("SwansonEgressRotation", () => {
  it("首次使用先把出口切过去", async () => {
    const { selector, calls } = makeSelector();
    const rotation = new SwansonEgressRotation({ selector, group: "G", exits, batchSize: 2 });
    await expect(rotation.prepare()).resolves.toBe("a");
    expect(calls).toEqual([["G", "a"]]);
    await rotation.prepare();
    expect(calls).toHaveLength(1);   // 重复调用不重复切
  });

  it("每满一批换下一个出口，循环回绕", async () => {
    const { selector, calls } = makeSelector();
    const rotation = new SwansonEgressRotation({ selector, group: "G", exits, batchSize: 2 });
    await rotation.prepare();
    expect(await rotation.recordProduct()).toBe(false);
    expect(await rotation.recordProduct()).toBe(true);
    expect(rotation.current).toBe("b");
    await rotation.recordProduct(); await rotation.recordProduct();
    expect(rotation.current).toBe("c");
    await rotation.recordProduct(); await rotation.recordProduct();
    expect(rotation.current).toBe("a");
    expect(calls.map(([, p]) => p)).toEqual(["a", "b", "c", "a"]);
  });

  it("被限流时立刻换，不等攒够一批", async () => {
    const { selector } = makeSelector();
    const rotation = new SwansonEgressRotation({ selector, group: "G", exits, batchSize: 100 });
    await rotation.prepare();
    await rotation.recordProduct();
    await rotation.rotateAfterBlock();
    expect(rotation.current).toBe("b");
    // 换完计数清零，不会立刻又触发一次
    expect(await rotation.recordProduct()).toBe(false);
  });

  it("没有可用出口时拒绝构造，而不是静默单点跑", () => {
    const { selector } = makeSelector();
    expect(() => new SwansonEgressRotation({ selector, group: "G", exits: [], batchSize: 1 })).toThrow(/exits_required/);
  });
});
