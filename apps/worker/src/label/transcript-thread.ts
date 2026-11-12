import { Piscina } from "piscina";
import {
  parsedValue,
  visionFailure,
  type ParseOutcome,
  type TranscriptParser,
} from "@crawl-automation/processing";

/** A copy's parse takes milliseconds; one that has not ended within a minute will not end (2026-11-12: ~11 h). */
export const TRANSCRIPT_PARSE_TIMEOUT_MS = 60_000;

/** The parse worker file beside the bundled main.js. */
export const parseWorkerFile = () => new URL("./parse-worker.js", import.meta.url).href;

/**
 * KAN-243 2026-11-12: the label copy's parse steps on a small thread pool, each with a time limit. A step past the limit
 * is aborted, its thread terminated and replaced, and only that product ends (VISION.LABEL_PARSE_TIMEOUT); the
 * worker's thread keeps its model turns, heartbeats and polling. Before, one copy's parse held the label model worker
 * at 100% CPU for good.
 */
export function threadedTranscriptParser(input: {
  filename: string;
  timeoutMs?: number;
  maxThreads?: number;
}): TranscriptParser & { close(): Promise<void> } {
  const pool = new Piscina({
    filename: input.filename,
    minThreads: 1,
    maxThreads: input.maxThreads ?? 2,
    idleTimeout: 60_000,
  });
  const timeoutMs = input.timeoutMs ?? TRANSCRIPT_PARSE_TIMEOUT_MS;
  return {
    async run(op, args) {
      const signal = AbortSignal.timeout(timeoutMs);
      let outcome: ParseOutcome;
      try {
        outcome = (await pool.run({ op, args }, { signal })) as ParseOutcome;
      } catch (error) {
        if (signal.aborted) {
          throw visionFailure("VISION.LABEL_PARSE_TIMEOUT", "executed", error);
        }
        throw error;
      }
      return parsedValue(outcome) as never;
    },
    close: () => pool.destroy(),
  };
}
