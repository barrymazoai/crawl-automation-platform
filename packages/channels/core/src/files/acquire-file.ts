import { isAppError } from "@crawl-automation/platform";
import { downloadFile } from "./file-download.js";
import { fileErrors } from "./file-errors.js";
import { checkedFileInput, FILE_POLICY } from "./file-policy.js";
import type { DnsResolver, SourceAccess, SourceLease } from "./file-ports.js";
import { acquireLease, releaseFileLease } from "./file-session.js";

export type AcquiredFile = Awaited<ReturnType<typeof downloadFile>>;
export interface FileSource {
  access: SourceAccess;
  dns: DnsResolver;
}

/** One invocation, one file. Prepared evidence never claims publication or registration. */
export async function acquireFile(
  raw: unknown,
  source: FileSource,
  abort: AbortSignal,
): Promise<AcquiredFile> {
  const input = checkedFileInput(raw);
  const controller = new AbortController();
  const signal = AbortSignal.any([abort, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(fileErrors.create("SOURCE.NETWORK_UNAVAILABLE")),
    FILE_POLICY.timeoutMs,
  );
  let lease: SourceLease | undefined;
  let failed = false;
  try {
    signal.throwIfAborted();
    lease = await acquireLease({ access: source.access, input }, signal);
    return await downloadFile({ input, lease, dns: source.dns }, signal);
  } catch (cause) {
    failed = true;
    if (isAppError(cause)) {
      throw cause;
    }
    throw fileErrors.create(
      signal.aborted ? "SOURCE.NETWORK_UNAVAILABLE" : "SOURCE.SESSION_UNAVAILABLE",
      { cause },
    );
  } finally {
    clearTimeout(timer);
    await releaseFileLease(lease, failed);
  }
}
