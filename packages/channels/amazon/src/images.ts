import { z } from "zod";
import type { ChannelProductEvidence } from "@crawl-automation/v3-contracts";
import type { AmazonElement } from "./dom.js";
import type { ScriptData } from "./script-data.js";

export const AMAZON_FILE_ORIGINS = [
  "https://m.media-amazon.com",
  "https://images-na.ssl-images-amazon.com",
  "https://images.amazon.com",
] as const;

const GallerySchema = z
  .array(
    z.object({
      hiRes: z.string().nullable().optional(),
      large: z.string().nullable().optional(),
    }),
  )
  .max(100);

function imageUrl(raw: string | null | undefined): string | null {
  const url = raw ? URL.parse(raw) : null;
  const allowed = AMAZON_FILE_ORIGINS.some((origin) => origin === url?.origin);
  return url &&
    allowed &&
    !url.username &&
    !url.password &&
    !url.hash &&
    url.pathname.startsWith("/images/I/")
    ? url.href
    : null;
}

function scriptedImages(data: ScriptData): string[] {
  return data.galleries.flatMap((raw) => {
    const gallery = GallerySchema.safeParse(raw);
    return gallery.success
      ? gallery.data.map((item) => imageUrl(item.hiRes) ?? imageUrl(item.large)).filter(Boolean)
      : [];
  }) as string[];
}

/**
 * Dynamic image attributes contain several resolutions of one image; keep its largest observed URL.
 */
function dynamicImage(image: AmazonElement): string | null {
  try {
    const raw: unknown = JSON.parse(image.getAttribute("data-a-dynamic-image") ?? "{}");
    const sizes = z.record(z.string(), z.tuple([z.number(), z.number()])).safeParse(raw);
    if (!sizes.success) {
      return null;
    }
    return (
      Object.entries(sizes.data)
        .sort((left, right) => right[1][0] * right[1][1] - left[1][0] * left[1][1])
        .map(([url]) => imageUrl(url))
        .find(Boolean) ?? null
    );
  } catch {
    // An invalid optional attribute gives no image; another observed source may still do so.
    return null;
  }
}

function domImages(root: AmazonElement): string[] {
  const selector = "#imageBlock img, #imageBlock_feature_div img, #landingImage, #imgBlkFront";
  return [...root.querySelectorAll(selector)]
    .map(
      (image) =>
        imageUrl(image.getAttribute("data-old-hires")) ??
        dynamicImage(image) ??
        imageUrl(image.getAttribute("src")),
    )
    .filter((url): url is string => url !== null);
}

/** The selected initial gallery, never recommendation images or galleries for other variations. */
export function amazonImages(
  root: AmazonElement,
  data: ScriptData,
): ChannelProductEvidence["imageCandidates"] {
  const scripted = scriptedImages(data);
  const urls = scripted.length ? scripted : domImages(root);
  return [...new Set(urls)].map((url) => ({
    url,
    variantId: null,
    basis: "selected-gallery",
    verifiedOriginal: false,
  }));
}
