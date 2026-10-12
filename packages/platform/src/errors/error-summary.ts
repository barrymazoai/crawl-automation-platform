// A Node-free leaf: workflow bundles import it through "@crawl-automation/platform/errors/summary".
import { errorCodeOf } from "./error-code.js";
import { z } from "zod";

export const SafeErrorSummarySchema = z.strictObject({
  code: z.string().max(96).nullable(),
  name: z.string().max(80),
  message: z.string().max(300),
  issues: z
    .array(
      z.strictObject({
        path: z.array(z.union([z.string().max(80), z.number().int()])).max(10),
        code: z.string().max(64),
        message: z.string().max(300),
      }),
    )
    .max(10)
    .optional(),
});
export type SafeErrorSummary = z.infer<typeof SafeErrorSummarySchema>;

/** Only diagnostic text: never stringify thrown objects, details, stacks, documents or bytes. */
function safeText(value: unknown, limit: number): string {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .slice(0, 8192)
    .replace(/(?:[a-z][a-z\d+.-]*:\/\/|www\.|data:)[^\s<>"']*/giu, "[url]")
    .replace(/[^\s<>"']*\?[^\s<>"']*/gu, "[url]")
    .replace(/\b(?:bearer|basic)\s+\S+/giu, "[credential]")
    .replace(
      /\b(?:authorization|cookie|password|passwd|(?:client[_-]?)?secret|(?:access[_-]?|refresh[_-]?)?token|api[_-]?key|credential)\b(?:\s*[=:]|\s+)[^]*/giu,
      "[redacted]",
    )
    .replace(/\b(?:document|html|bytes|body|payload)\b\s*[=:][^]*/giu, "[redacted]")
    .replace(/[<{[][^]*$/u, "[redacted]")
    .replace(/["'`][^]*$/u, "[redacted]")
    .replace(/[\r\n][^]*$/u, " [redacted]")
    .replace(/\b[A-Za-z\d_+/=-]{48,}\b/gu, "[data]")
    .replace(/\p{Cc}/gu, " ")
    .slice(0, limit);
}

/** Redacted, bounded diagnostic text for Review details (URLs, credentials, markup and long tokens removed). */
export function safeDiagnosticText(value: unknown, limit = 200): string | undefined {
  return safeText(value, limit) || undefined;
}

/** An object-store key as written by this system: path characters only, so no query string, markup or spaces. */
export function safeObjectKey(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w.\-/]{1,200}$/u.test(value) ? value : undefined;
}

function field(value: unknown, key: string): unknown {
  try {
    return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
  } catch {
    return undefined;
  }
}

/** Temporal uses ApplicationFailure.type for the original error code/name. */
function ownCode(error: unknown): string | null {
  return errorCodeOf({ code: field(error, "code") }) ?? errorCodeOf({ code: field(error, "type") });
}

/** The activity guard transports AppError.details as the first ApplicationFailure detail. */
function retainedCause(error: unknown): SafeErrorSummary | undefined {
  const details = field(error, "details");
  const cause = field(Array.isArray(details) ? details[0] : details, "cause");
  const parsed = SafeErrorSummarySchema.safeParse(cause);
  return parsed.success ? parsed.data : undefined;
}

function issueSummary(issue: unknown) {
  const path = field(issue, "path");
  return {
    path: Array.isArray(path)
      ? path
          .slice(0, 10)
          .map((part: unknown) =>
            typeof part === "number" && Number.isSafeInteger(part) ? part : safeText(part, 80),
          )
      : [],
    code: safeText(field(issue, "code"), 64),
    message: safeText(field(issue, "message"), 300),
  };
}

function zodIssues(error: unknown): unknown[] | undefined {
  const zod = field(error, "name") === "ZodError" || field(error, "type") === "ZodError";
  if (!zod) {
    return undefined;
  }
  const issues = field(error, "issues");
  if (Array.isArray(issues)) {
    return issues;
  }
  // Temporal serializes a ZodError's issues in its message, without custom properties.
  const message = field(error, "message");
  if (typeof message !== "string" || message.length > 16_384) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(message);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Bounded, deterministic and workflow-safe; only the innermost available cause is retained. */
export function safeErrorSummary(error: unknown): SafeErrorSummary {
  let current = error;
  let code: string | null = null;
  for (let depth = 0; depth < 6; depth++) {
    code = ownCode(current) ?? code;
    const cause = retainedCause(current) ?? field(current, "cause");
    if (!cause || cause === current || typeof cause !== "object") {
      break;
    }
    current = cause;
  }
  return summarize(current, code);
}

function summarize(current: unknown, code: string | null): SafeErrorSummary {
  const issues = zodIssues(current);
  return {
    code: code?.slice(0, 96) ?? null,
    name: issues ? "ZodError" : safeText(field(current, "name"), 80) || "UnknownError",
    message: issues
      ? "Validation failed"
      : safeText(typeof current === "string" ? current : field(current, "message"), 300),
    ...(issues ? { issues: issues.slice(0, 10).map(issueSummary) } : {}),
  };
}
