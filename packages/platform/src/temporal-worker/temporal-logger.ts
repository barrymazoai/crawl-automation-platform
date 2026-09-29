import { Runtime, type Logger as TemporalLogger, type LogLevel } from "@temporalio/worker";
import type { Logger } from "../logger/create-logger.js";

type PinoLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, PinoLevel> = {
  TRACE: "trace",
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
};

/** Temporal's logger interface, answered by pino, so the SDK's own lines are JSON lines like ours. */
function temporalLogger(log: Logger): TemporalLogger {
  const at =
    (level: PinoLevel) =>
    (message: string, meta: Record<string, unknown> = {}) =>
      log[level](meta, message);
  return {
    log: (level, message, meta) => at(LEVELS[level])(message, meta),
    trace: at("trace"),
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
}

let installed = false;

/**
 * Sends the Temporal SDK's log lines through pino. Temporal allows one runtime per process, installed before the
 * first connection, so this installs it once.
 */
export function installTemporalLogger(log: Logger): void {
  if (installed) {
    return;
  }
  Runtime.install({ logger: temporalLogger(log.child({ source: "temporal" })) });
  installed = true;
}
