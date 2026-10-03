import { z } from "zod";
import { captureFile, type CaptureFile } from "./archive.js";
import { CaptureReviewSchema } from "./product-review.js";
import { assertMaterialVariantIds } from "../../../../../crawl-products/lib/material-variants.mjs";

const MaterialsSchema = z.strictObject({
  selectedVariantId: z.string().nullable(),
  productHtml: z.string().min(1),
  variants: z.array(z.unknown()).max(200),
});

interface MaterialRecord {
  productUrl: string;
  fields: Record<string, unknown>;
  gallery: { url: string }[];
  variants: Array<{ variantId?: string | undefined }>;
}

/** Read the collector's file index. No model call or product-content extraction. */
export async function capturedMaterials(input: {
  root: string;
  files: CaptureFile[];
  record: MaterialRecord;
}) {
  const { record } = input;
  const materials = MaterialsSchema.parse(
    JSON.parse((await captureFile(input.root, "materials.json")).toString()),
  );
  assertMaterialVariantIds(record.variants, materials);
  const metadata = new Set(["title", "brand", "currency", "images"]);
  if (Object.keys(record.fields).some((name) => !metadata.has(name))) {
    throw new Error("capture_contains_parsed_product_fields");
  }
  const detailsHtml = await materialHtml(input, materials.productHtml);
  const galleryUrls = record.gallery.map((image) => image.url);
  const review = CaptureReviewSchema.parse({
    productUrl: record.productUrl,
    selectedVariantId: materials.selectedVariantId,
    galleryUrls,
    galleryComplete: true,
    variantsComplete: true,
    detailComplete: true,
    method: "collector-completed-materials",
    surface: "local_file",
    verifier: "capture",
    evidence: ["materials.json", materials.productHtml],
    materialScopes: materials.variants,
    imageAssignments: galleryUrls.map((url) => ({
      url,
      variantId: null,
      basis: "product-gallery",
    })),
  });
  return { review, detailsHtml };
}

export async function materialHtml(input: { root: string; files: CaptureFile[] }, path: string) {
  if (!input.files.some((file) => file.path === path && file.mediaType === "text/html")) {
    throw new Error("material_html_not_archived");
  }
  return (await captureFile(input.root, path)).toString();
}
