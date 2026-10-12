import { isAppError } from "@crawl-automation/platform";
import { z } from "zod";
import type { Response } from "./file-ports.js";

function diagnosticUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.slice(0, 2048);
  } catch {
    return null;
  }
}

// Only these small response facts may leave acquisition; never copy arbitrary error details.
const diagnosticsSchema = z.object({
  httpStatus: z.number().int().min(100).max(599).optional(),
  sourceUrl: z.string().transform(diagnosticUrl).nullable().optional(),
  finalUrl: z.string().transform(diagnosticUrl).nullable().optional(),
  redirects: z.number().int().nonnegative().optional(),
  contentType: z
    .string()
    .transform((value) => value.slice(0, 256))
    .nullable()
    .optional(),
  sniffedMediaType: z
    .enum([
      "image/png",
      "image/jpeg",
      "image/webp",
      "application/pdf",
      "image/gif",
      "image/avif",
      "text/html",
    ])
    .nullable()
    .default(null),
  byteSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
});

export function fileDiagnostics(error: unknown) {
  if (!isAppError(error) || !["SOURCE.HTTP_STATUS", "ARTIFACT.MEDIA_TYPE"].includes(error.code)) {
    return {};
  }
  const parsed = diagnosticsSchema.safeParse(error.details);
  return parsed.success ? parsed.data : {};
}

export function responseDiagnostics(
  response: Response,
  context: { initial: URL; url: URL; redirects: number },
) {
  const length = response.headers["content-length"];
  const byteSize = length !== undefined && /^\d+$/.test(length) ? Number(length) : null;
  return {
    httpStatus: response.status,
    sourceUrl: diagnosticUrl(context.initial.href),
    finalUrl: diagnosticUrl(context.url.href),
    redirects: context.redirects,
    contentType: response.headers["content-type"] ?? null,
    byteSize: Number.isSafeInteger(byteSize) ? byteSize : null,
  };
}
