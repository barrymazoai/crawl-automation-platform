import type { ErrorCategorySchema } from "@crawl-automation/v3-contracts";
import type { z } from "zod";

export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

/** An error code is `AREA.NAME` in upper case, e.g. `RUN.NOT_FOUND`. */
export type ErrorCode = `${Uppercase<string>}.${Uppercase<string>}`;

export interface ErrorSpec {
  readonly category: ErrorCategory;
  readonly message: string;
}

export interface AppErrorOptions {
  message: string;
  cause?: unknown;
  details?: Record<string, unknown>;
}

/** Every error the system raises on purpose. Code decides by `code`, never by `message`. */
export class AppError extends Error {
  override readonly name = "AppError";
  readonly details: Record<string, unknown>;

  constructor(
    readonly code: ErrorCode,
    readonly category: ErrorCategory,
    options: AppErrorOptions,
  ) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.details = options.details ?? {};
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
