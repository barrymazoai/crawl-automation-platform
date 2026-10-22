import { createHash } from "node:crypto";
import { productDeliveryErrors } from "@crawl-automation/app";
import type { ObjectStore } from "@crawl-automation/platform";

/** Verify retained bytes before decoding either a projection or an original HTML page. */
export async function retainedValue(
  objects: Pick<ObjectStore, "read">,
  reference: { objectKey: string; sha256: string },
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const bytes = await objects.read(reference.objectKey, 8 * 1024 * 1024, signal);
  if (!bytes) {
    return undefined;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
    throw productDeliveryErrors.create("PRODUCT_DELIVERY.INTEGRITY");
  }
  const text = Buffer.from(bytes).toString("utf8").trimStart();
  return text.startsWith("{") ? JSON.parse(text) : text;
}
