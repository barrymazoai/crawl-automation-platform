import { isAppError } from "@crawl-automation/platform";
import { abortable } from "./abortable.js";
import { fileErrors } from "./file-errors.js";
import { FILE_POLICY } from "./file-policy.js";
import type { Response } from "./file-ports.js";

function expectedLength(response: Response): number | null {
  const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
  if (encoding && encoding !== "identity") {
    throw fileErrors.create("SOURCE.ENCODING");
  }
  const length = response.headers["content-length"];
  if (length !== undefined && !/^\d+$/.test(length)) {
    throw fileErrors.create("ARTIFACT.INTEGRITY");
  }
  const expected = length === undefined ? null : Number(length);
  if (expected !== null && (!Number.isSafeInteger(expected) || expected > FILE_POLICY.maxBytes)) {
    throw fileErrors.create("ARTIFACT.TOO_LARGE");
  }
  return expected;
}

async function chunksOf(
  response: Response,
  signal: AbortSignal,
  active: () => void,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  while (true) {
    active();
    const chunk = await abortable(iterator.next(), signal);
    signal.throwIfAborted();
    active();
    if (chunk.done) {
      return Buffer.concat(chunks, size);
    }
    size += chunk.value.byteLength;
    if (size > FILE_POLICY.maxBytes) {
      throw fileErrors.create("ARTIFACT.TOO_LARGE");
    }
    chunks.push(Buffer.from(chunk.value));
  }
}

export async function readFileBody(response: Response, signal: AbortSignal, active: () => void) {
  const expected = expectedLength(response);
  let bytes: Buffer;
  try {
    bytes = await chunksOf(response, signal, active);
  } catch (cause) {
    if (isAppError(cause)) {
      throw cause;
    }
    throw fileErrors.create("SOURCE.NETWORK_UNAVAILABLE", { cause });
  } finally {
    response.close();
  }
  if (!bytes.length || (expected !== null && bytes.length !== expected)) {
    throw fileErrors.create("ARTIFACT.INTEGRITY");
  }
  return bytes;
}
