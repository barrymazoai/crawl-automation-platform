import type { RetainedPublication } from "@crawl-automation/platform";
import type { readCapturedProduct } from "./product-record.js";

/** Keep the native gallery inventory beside the retained original page. */
export function saveCapturedImages(
  publication: RetainedPublication,
  input: {
    prefix: string;
    url: string;
    images: Awaited<ReturnType<typeof readCapturedProduct>>["images"];
  },
  signal: AbortSignal,
) {
  return publication.publish(
    `${input.prefix}/images.json`,
    Buffer.from(
      JSON.stringify({ version: "dtc-agent-images/1", url: input.url, images: input.images }),
    ),
    "application/json",
    signal,
  );
}
