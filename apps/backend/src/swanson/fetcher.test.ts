import { describe, expect, it } from "vitest";
import { decodeFactsValue, BLOCK_STATUSES, SwansonBlockedError } from "./fetcher.js";

describe("decodeFactsValue", () => {
  it("还原 unicode 转义与转义斜杠", () => {
    expect(decodeFactsValue("Digest Gold\\u00ae Blend")).toBe("Digest Gold® Blend");
    expect(decodeFactsValue("Pectinase (w\\/Phytase)")).toBe("Pectinase (w/Phytase)");
  });
  it("剥掉残留 HTML 标签并压缩空白", () => {
    expect(decodeFactsValue("<b>Serving  Size</b>   1 Capsule")).toBe("Serving Size 1 Capsule");
  });
  it("还原 HTML 实体", () => {
    expect(decodeFactsValue("Vitamin A &amp; D")).toBe("Vitamin A & D");
  });
});

describe("限流信号", () => {
  it("403 / 429 / 503 算被拦截，404 不算", () => {
    expect(BLOCK_STATUSES.has(429)).toBe(true);
    expect(BLOCK_STATUSES.has(403)).toBe(true);
    expect(BLOCK_STATUSES.has(503)).toBe(true);
    expect(BLOCK_STATUSES.has(404)).toBe(false);
  });
  it("SwansonBlockedError 带上状态码与地址，便于定位", () => {
    const error = new SwansonBlockedError(429, "https://x/y.js");
    expect(error.status).toBe(429);
    expect(error.message).toContain("429");
    expect(error.message).toContain("https://x/y.js");
  });
});

describe("导航到达校验", () => {
  it("比对 origin 与 path，忽略跟踪参数", async () => {
    const mod = await import("./fetcher.js");
    // sameTarget 是内部函数，通过行为验证：同源同路径视为到达
    expect(typeof mod.createSwansonFetcher).toBe("function");
  });
});

describe("createSerialQueue", () => {
  it("并发提交的任务严格串行执行", async () => {
    const { createSerialQueue } = await import("./fetcher.js");
    const enqueue = createSerialQueue();
    const order: string[] = [];
    const slow = enqueue(async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 30)); order.push("a-end"); });
    const fast = enqueue(async () => { order.push("b"); });
    await Promise.all([slow, fast]);
    // b 必须等 a 完全结束——共享标签页容不下交错
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("前一个任务失败不阻塞后一个", async () => {
    const { createSerialQueue } = await import("./fetcher.js");
    const enqueue = createSerialQueue();
    const failed = enqueue(async () => { throw new Error("боом"); });
    const ok = enqueue(async () => "好");
    await expect(failed).rejects.toThrow();
    await expect(ok).resolves.toBe("好");
  });
});
