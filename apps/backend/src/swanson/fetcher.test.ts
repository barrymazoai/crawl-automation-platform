import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpFetcher, createResilientFetcher, SwansonBlockedError } from "./fetcher.js";

const signal = new AbortController().signal;
const res = (status: number, body = "ok", headers: Record<string, string> = {}) =>
  ({ ok: status >= 200 && status < 300, status, text: async () => body, headers: { get: (k: string) => headers[k] ?? null } }) as any;

afterEach(() => { vi.unstubAllGlobals(); });

describe("createHttpFetcher", () => {
  it("正常响应直接返回正文", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(200, "{\"a\":1}")));
    await expect(createHttpFetcher().text("https://x/1.js", signal)).resolves.toBe("{\"a\":1}");
  });

  it("429 按 Retry-After 说的时长等待后重试", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(429, "", { "retry-after": "3" }))
      .mockResolvedValueOnce(res(200, "好了"));
    vi.stubGlobal("fetch", fetchMock);
    const slept: number[] = [];
    const fetcher = createHttpFetcher({ sleep: async (ms) => { slept.push(ms); } });
    await expect(fetcher.text("https://x/1.js", signal)).resolves.toBe("好了");
    expect(slept).toEqual([3000]);
  });

  it("没有 Retry-After 时指数退避", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(503)));
    const slept: number[] = [];
    const fetcher = createHttpFetcher({ backoffMs: 100, maxRetries: 3, sleep: async (ms) => { slept.push(ms); } });
    await expect(fetcher.text("https://x/1.js", signal)).rejects.toThrow(SwansonBlockedError);
    expect(slept).toEqual([100, 200, 400]);
  });

  it("404 这类业务错误立即抛出，不浪费退避预算", async () => {
    const fetchMock = vi.fn(async () => res(404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(createHttpFetcher().text("https://x/nope.js", signal)).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createResilientFetcher", () => {
  it("成功一次就把连续拦截计数清零——偶发抖动不该攒成切换理由", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(429))   // 第一次调用：重试耗尽
      .mockResolvedValue(res(200, "好"));
    vi.stubGlobal("fetch", fetchMock);
    const events: any[] = [];
    const fetcher = createResilientFetcher({ maxRetries: 1, backoffMs: 1, switchAfterBlocks: 2, sleep: async () => {}, log: (e) => events.push(e) });
    await expect(fetcher.text("https://x/1.js", signal)).rejects.toThrow(SwansonBlockedError);
    await expect(fetcher.text("https://x/2.js", signal)).resolves.toBe("好");
    expect(fetcher.mode).toBe("http");
    expect(events.some((e) => e.type === "swanson_switch_to_browser")).toBe(false);
  });

  it("连续被拦截到阈值才切浏览器", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(429)));
    const events: any[] = [];
    const fetcher = createResilientFetcher({ maxRetries: 0, switchAfterBlocks: 2, sleep: async () => {}, log: (e) => events.push(e) });
    await expect(fetcher.text("https://x/1.js", signal)).rejects.toThrow(SwansonBlockedError);
    expect(fetcher.mode).toBe("http");
    // 第二次连续被拦截时触发切换（浏览器不可用会抛别的错，但切换事件已记录）
    await fetcher.text("https://x/2.js", signal).catch(() => {});
    expect(events.some((e) => e.type === "swanson_switch_to_browser")).toBe(true);
  });

  it("switchAfterBlocks=0 表示永不切换", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(429)));
    const fetcher = createResilientFetcher({ maxRetries: 0, switchAfterBlocks: 0, sleep: async () => {} });
    for (let i = 0; i < 5; i += 1) await fetcher.text(`https://x/${i}.js`, signal).catch(() => {});
    expect(fetcher.mode).toBe("http");
  });
});
