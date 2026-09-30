import { isAppError, recordRecovery } from "@crawl-automation/platform";
import type { FileAcquireInput } from "@crawl-automation/v3-contracts";
import { abortable } from "./abortable.js";
import { fileErrors } from "./file-errors.js";
import type { SourceAccess, SourceLease } from "./file-ports.js";

export async function acquireLease(
  request: { access: SourceAccess; input: FileAcquireInput },
  signal: AbortSignal,
): Promise<SourceLease> {
  const pending = request.access.acquire(request.input, signal).then(async (lease) => {
    if (signal.aborted) {
      await lease.release();
      signal.throwIfAborted();
    }
    return lease;
  });
  return abortable(pending, signal);
}

export function assertFileSession(lease: SourceLease, input: FileAcquireInput): void {
  try {
    lease.assertActive();
  } catch (cause) {
    if (isAppError(cause)) {
      throw cause;
    }
    throw fileErrors.create("SOURCE.SESSION_UNAVAILABLE", { cause });
  }
  const fields = [
    "schemaVersion",
    "requestId",
    "observationId",
    "brandId",
    "sourceId",
    "listingId",
    "variantId",
  ] as const;
  const matches = fields.every((field) => lease.owner[field] === input[field]);
  if (
    !matches ||
    lease.sourceId !== input.sourceId ||
    lease.resourceId !== input.resourceId ||
    lease.binding.sessionId !== input.binding.sessionId ||
    lease.binding.egressId !== input.binding.egressId ||
    lease.transport.egressId !== input.binding.egressId
  ) {
    throw fileErrors.create("SOURCE.SESSION_MISMATCH");
  }
}

export function safeHeaders(raw: Readonly<Record<string, string>>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const name = key.toLowerCase();
    if (
      !["cookie", "authorization", "user-agent", "accept", "referer"].includes(name) ||
      headers[name] ||
      typeof value !== "string" ||
      value.length > 8192 ||
      /[\r\n\0]/.test(value)
    ) {
      throw fileErrors.create("SOURCE.SESSION_MISMATCH");
    }
    headers[name] = value;
  }
  return headers;
}

/** Unpin only this operation; the lease never owns the caller's browser. */
export async function releaseFileLease(lease: SourceLease | undefined, failed: boolean) {
  if (!lease) {
    return;
  }
  try {
    await abortable(lease.release(), AbortSignal.timeout(5000));
  } catch (cause) {
    if (!failed) {
      throw fileErrors.create("SOURCE.SESSION_UNAVAILABLE", { cause });
    }
    recordRecovery(cause, { operation: "file.release" });
  }
}
