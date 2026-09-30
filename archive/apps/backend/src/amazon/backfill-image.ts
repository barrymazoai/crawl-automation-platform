import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { OcrResponse } from "./ocr-label-pipeline.js";
import { mapWithConcurrency, selectFactsOcrImages, type IndexedOcrImage } from "./ocr-label-pipeline.js";

export interface AmazonBackfillImageRow {
  id: string;
  productId: string;
  imageUrl: string;
}

export interface AmazonImageEvidence {
  productId: string;
  totalImages: number;
  ocrSucceeded: number;
  ocrFailed: number;
  factsCandidates: Array<{ imageId: string; imageUrl: string; imageIndex: number; response: OcrResponse }>;
  failures: Array<{ imageId: string; imageUrl: string; reason: string }>;
}

function extension(contentType: string | null, imageUrl: string) {
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("gif")) return ".gif";
  if (contentType?.includes("avif")) return ".avif";
  try {
    const suffix = path.extname(new URL(imageUrl).pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"].includes(suffix)) return suffix;
  } catch {}
  return ".jpg";
}

export async function downloadAmazonBackfillImage(options: {
  imageUrl: string;
  cacheKey: string;
  cacheDirectory: string;
  fetchImpl: typeof fetch;
}) {
  const key = createHash("sha256").update(options.cacheKey).digest("hex");
  const existing = (await fs.readdir(options.cacheDirectory).catch(() => []))
    .find((name) => name.startsWith(`${key}.`));
  if (existing) return path.join(options.cacheDirectory, existing);
  const response = await options.fetchImpl(options.imageUrl, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; SupplySmartBackfill/1.0)" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`image_http_${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > 25 * 1024 * 1024) throw new Error("image_too_large");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("image_too_large");
  await fs.mkdir(options.cacheDirectory, { recursive: true });
  const filename = path.join(options.cacheDirectory, `${key}${extension(response.headers.get("content-type"), options.cacheKey)}`);
  await fs.writeFile(filename, bytes);
  return filename;
}

export function createR2ImageUrlResolver(env: NodeJS.ProcessEnv = process.env) {
  const accessKeyId = env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  const secretAccessKey = env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  const endpoint = env.CLOUDFLARE_R2_ENDPOINT;
  const bucket = env.CLOUDFLARE_R2_BUCKET;
  const region = env.CLOUDFLARE_R2_REGION || "auto";
  const client = accessKeyId && secretAccessKey && endpoint
    ? new S3Client({ region, endpoint, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true })
    : null;
  return async (value: string) => {
    if (/^https?:\/\//i.test(value)) return value;
    if (!client || !bucket) throw new Error("image_object_key_requires_r2_credentials");
    return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: value }), { expiresIn: 900 });
  };
}

export async function buildAmazonImageEvidence(options: {
  productId: string;
  images: AmazonBackfillImageRow[];
  cacheDirectory: string;
  imageConcurrency: number;
  recognize: (filename: string) => Promise<OcrResponse>;
  fetchImpl?: typeof fetch;
  resolveImageUrl?: (value: string) => Promise<string>;
}): Promise<AmazonImageEvidence> {
  await fs.mkdir(options.cacheDirectory, { recursive: true });
  const results = await mapWithConcurrency(options.images, options.imageConcurrency, async (image, index) => {
    try {
      const resolvedUrl = options.resolveImageUrl ? await options.resolveImageUrl(image.imageUrl) : image.imageUrl;
      const filename = await downloadAmazonBackfillImage({
        imageUrl: resolvedUrl,
        cacheKey: image.imageUrl,
        cacheDirectory: options.cacheDirectory,
        fetchImpl: options.fetchImpl ?? fetch,
      });
      const ocrFile = `${filename}.ocr.json`;
      let response: OcrResponse;
      try {
        response = JSON.parse(await fs.readFile(ocrFile, "utf8")) as OcrResponse;
      } catch {
        response = await options.recognize(filename);
        await fs.writeFile(ocrFile, `${JSON.stringify(response, null, 2)}\n`);
      }
      return { ok: true as const, image, indexed: { index, fileName: path.basename(filename), response } satisfies IndexedOcrImage };
    } catch (error) {
      return { ok: false as const, image, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  const successful = results.filter((item) => item.ok);
  const selectedIndexes = new Set(selectFactsOcrImages(successful.map((item) => item.indexed)).map((item) => item.index));
  return {
    productId: options.productId,
    totalImages: options.images.length,
    ocrSucceeded: successful.length,
    ocrFailed: results.length - successful.length,
    factsCandidates: successful.flatMap((item) => selectedIndexes.has(item.indexed.index) ? [{
      imageId: item.image.id,
      imageUrl: item.image.imageUrl,
      imageIndex: item.indexed.index,
      response: item.indexed.response,
    }] : []),
    failures: results.flatMap((item) => item.ok ? [] : [{ imageId: item.image.id, imageUrl: item.image.imageUrl, reason: item.reason }]),
  };
}
