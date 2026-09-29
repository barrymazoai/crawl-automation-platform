import { pino, type DestinationStream, type Logger } from "pino";
import type { LogConfig } from "../config/schemas.js";

export type { Logger } from "pino";

export interface LoggerOptions extends Partial<LogConfig> {
  /** The process or service name, e.g. `api` or `worker`. */
  name: string;
  /** Where lines go. Standard output unless a test passes its own stream. */
  destination?: DestinationStream;
}

/**
 * The one logger. Lines are JSON with a level and time. Pass context with `log.child({ runId })`
 * so every line of one run can be found with a single filter.
 */
export function createLogger(options: LoggerOptions): Logger {
  const settings = { name: options.name, level: options.level ?? "info" };
  return options.destination ? pino(settings, options.destination) : pino(settings);
}
