import { describe, expect, it, vi } from "vitest";
import { HistoryService, type ProductHistoryReader } from "./history-service.js";

describe("HistoryService", () => {
  it("reads a listing's metrics history by channel and product ID", async () => {
    const answer = { listings: [], points: [] };
    const history: ProductHistoryReader = { find: vi.fn(async () => answer) };
    const service = new HistoryService({ history });

    expect(await service.list({ channel: "wholefoods", externalId: " B002CQU54Q " })).toBe(answer);
    expect(history.find).toHaveBeenCalledWith({
      channel: "wholefoods",
      externalId: "B002CQU54Q",
      kind: "metrics",
      limit: 100,
    });
  });

  it("refuses an unknown channel before reading", async () => {
    const history: ProductHistoryReader = { find: vi.fn() };
    const service = new HistoryService({ history });

    await expect(service.list({ channel: "walmart", externalId: "1" })).rejects.toThrow();
    expect(history.find).not.toHaveBeenCalled();
  });
});
