import { Writable } from "node:stream";
import { createLogger, type JournalPruneReport } from "@crawl-automation/platform";
import { describe, expect, it, vi } from "vitest";
import { JournalPruneService, untilNextTick } from "./journal-prune-service.js";

const log = createLogger({
  name: "journal-prune-test",
  destination: new Writable({ write: (_chunk, _encoding, done) => done() }),
});

const report = (removeFiles: boolean) => ({ removeFiles, removed: 3 }) as JournalPruneReport;

describe("JournalPruneService", () => {
  it("previews by default and keeps the last result", async () => {
    const prune = vi.fn(async (removeFiles: boolean) => report(removeFiles));
    const service = new JournalPruneService({ prune, log, intervalMs: null });

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
    const service = new JournalPruneService({ prune, log, intervalMs: null });

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

describe("untilNextTick", () => {
  const HOUR = 3_600_000;

  it("waits for the next full hour, or a whole hour when on the dot", () => {
    expect(untilNextTick(new Date("2026-10-21T03:30:00Z"), HOUR)).toBe(30 * 60_000);
    expect(untilNextTick(new Date("2026-10-21T03:59:59.999Z"), HOUR)).toBe(1);
    expect(untilNextTick(new Date("2026-10-21T04:00:00Z"), HOUR)).toBe(HOUR);
  });

  it("aligns other intervals to midnight UTC", () => {
    expect(untilNextTick(new Date("2026-10-21T03:10:00Z"), 30 * 60_000)).toBe(20 * 60_000);
    expect(untilNextTick(new Date("2026-10-21T20:00:00Z"), 24 * HOUR)).toBe(4 * HOUR);
  });
});
