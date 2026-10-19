import { Writable } from "node:stream";
import { createLogger, type JournalPruneReport } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { JournalPruneService, untilNextHour } from "./journal-prune-service.js";

const log = createLogger({
  name: "journal-prune-test",
  destination: new Writable({ write: (_chunk, _encoding, done) => done() }),
});

const report = (removeFiles: boolean) => ({ removeFiles, removed: 3 }) as JournalPruneReport;

describe("JournalPruneService", () => {
  it("previews by default and keeps the last result", async () => {
    const prune = vi.fn(async (removeFiles: boolean) => report(removeFiles));
    const service = new JournalPruneService({ prune, log, dailyAtUtcHour: null });

    expect(service.start({}).running).toMatchObject({ removeFiles: false });
    await vi.waitFor(() => expect(service.status().running).toBeNull());

    expect(prune).toHaveBeenCalledWith(false, expect.any(AbortSignal));
    expect(service.status()).toMatchObject({ last: { removed: 3 }, lastError: null });
  });

  it("refuses a second prune while one runs and records a failure", async () => {
    let fail: (error: Error) => void = () => undefined;
    const prune = vi.fn(
      () => new Promise<JournalPruneReport>((_resolve, reject) => (fail = reject)),
    );
    const service = new JournalPruneService({ prune, log, dailyAtUtcHour: null });

    service.start({ dryRun: false });
    expect(() => service.start({})).toThrow(
      expect.objectContaining({ code: "JOURNAL_PRUNE.BUSY" }),
    );
    fail(new Error("R2 unavailable"));
    await vi.waitFor(() => expect(service.status().running).toBeNull());

    expect(service.status().lastError).toContain("R2 unavailable");
    expect(prune).toHaveBeenCalledOnce();
  });
});

describe("untilNextHour", () => {
  it("waits for the hour today, or tomorrow once it has passed", () => {
    expect(untilNextHour(new Date("2026-10-19T18:30:00Z"), 20)).toBe(90 * 60_000);
    expect(untilNextHour(new Date("2026-10-19T20:00:00Z"), 20)).toBe(24 * 3_600_000);
  });
});
