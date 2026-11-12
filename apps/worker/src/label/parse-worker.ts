import {
  parseOutcome,
  runTranscriptParseOp,
  type ParseOutcome,
  type TranscriptParseOp,
} from "@crawl-automation/processing";

/**
 * KAN-243 2026-11-12: the worker-thread entry of the label copy's parse steps (built to dist/parse-worker.js beside
 * main.js). A step that runs past its time limit is ended with its thread; the worker's own thread never runs it.
 */
export default function parse(task: { op: TranscriptParseOp; args: unknown[] }): ParseOutcome {
  return parseOutcome(() => runTranscriptParseOp(task.op, task.args as never));
}
