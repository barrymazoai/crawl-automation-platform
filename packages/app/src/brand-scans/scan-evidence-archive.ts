import { createHash } from "node:crypto";
import { z } from "zod";
import { brandScanErrors } from "@crawl-automation/channels-core";
import type { ObjectStore } from "@crawl-automation/platform";
import { appErrors } from "../errors.js";

const RecordSchema = z.object({
  codec: z.literal("brand-scan-page/1"),
  url: z.url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z
    .number()
    .int()
    .min(1)
    .max(8 * 1024 * 1024),
  creditCost: z.number().nonnegative().nullable(),
});

/** Read only: the existing immutable body and receipt must agree before JSON is exposed. */
export async function readScanArchive(
  objects: Pick<ObjectStore, "read">,
  archiveKey: string,
  signal: AbortSignal,
) {
  const receipt = await objects.read(archiveKey.replace(/\.json$/, ".record.json"), 65_536, signal);
  const parsed = RecordSchema.safeParse(receipt ? parseJson(receipt) : null);
  if (!parsed.success) {
    throw brandScanErrors.create("BRAND_SCAN.ARCHIVE_UNVERIFIED", {
      details: { archiveKey },
      cause: parsed.error,
    });
  }
  const record = parsed.data;
  const bytes = await objects.read(archiveKey, record.byteSize, signal);
  if (!bytes) {
    throw appErrors.create("EVIDENCE.NOT_FOUND", { details: { archiveKey } });
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== record.byteSize || sha256 !== record.sha256) {
    throw brandScanErrors.create("BRAND_SCAN.ARCHIVE_UNVERIFIED", { details: { archiveKey } });
  }
  return { record, body: new TextDecoder().decode(bytes), json: parseJson(bytes) };
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw brandScanErrors.create("BRAND_SCAN.NOT_JSON", { cause });
  }
}
