import { Readable } from "node:stream";
import type { GetObjectCommandOutput } from "@aws-sdk/client-s3";
import { artifactErrors } from "./artifact-errors.js";

export async function readR2Body(
  response: GetObjectCommandOutput,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const body = response.Body;
  if (!(body instanceof Readable)) {
    throw artifactErrors.create("ARTIFACT.UNAVAILABLE");
  }
  const abort = () => body.destroy(artifactErrors.create("ARTIFACT.UNAVAILABLE"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) {
      abort();
    }
    if (response.ContentLength !== undefined && response.ContentLength > maxBytes) {
      throw artifactErrors.create("ARTIFACT.TOO_LARGE");
    }
    return await collectBody(body, maxBytes, signal);
  } finally {
    signal.removeEventListener("abort", abort);
    body.destroy();
  }
}

async function collectBody(body: Readable, maxBytes: number, signal: AbortSignal) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<unknown>) {
    signal.throwIfAborted();
    if (!(chunk instanceof Uint8Array)) {
      throw artifactErrors.create("ARTIFACT.UNAVAILABLE");
    }
    size += chunk.byteLength;
    if (size > maxBytes) {
      throw artifactErrors.create("ARTIFACT.TOO_LARGE");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
