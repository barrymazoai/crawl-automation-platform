import { AppError, type ErrorCode, type ErrorSpec } from "./app-error.js";

export interface RaiseOptions {
  cause?: unknown;
  details?: Record<string, unknown>;
}

/**
 * Declares one layer's error codes in one place and returns typed helpers.
 * Each layer owns a prefix (`CONFIG.`, `RUN.`, …), so codes stay unique across layers.
 */
export function defineErrors<const Code extends ErrorCode>(codes: Record<Code, ErrorSpec>) {
  function create(code: Code, options: RaiseOptions = {}): AppError {
    const spec = codes[code];
    return new AppError(code, spec.category, { message: spec.message, ...options });
  }

  function is(error: unknown, code: Code): error is AppError {
    return error instanceof AppError && error.code === code;
  }

  return { codes, create, is };
}
