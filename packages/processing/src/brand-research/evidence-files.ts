import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { brandResearchErrors } from "./errors.js";

export const PageReceiptSchema = z.object({
  url: z.url({ protocol: /^https?$/ }),
  observedAt: z.iso.datetime(),
  path: z.string().regex(/^pages\/[a-f0-9-]+\.html$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().positive().max(16_777_216),
});
export type PageReceipt = z.infer<typeof PageReceiptSchema>;

/** A retained page cannot redirect the host's file reads outside its isolated workspace. */
export async function evidenceFile(root: string, name: string): Promise<Buffer | null> {
  const path = resolve(root, name);
  const local = relative(root, path);
  if (!local || local.startsWith("..") || isAbsolute(local)) {
    throw brandResearchErrors.create("BRAND_RESEARCH.EVIDENCE_INVALID");
  }
  const stat = await lstat(path).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return null;
    }
    throw cause;
  });
  if (!stat) {
    return null;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 32 * 1024 * 1024 ||
    (await realpath(path)) !== path
  ) {
    throw brandResearchErrors.create("BRAND_RESEARCH.EVIDENCE_INVALID", { details: { name } });
  }
  return readFile(path);
}
