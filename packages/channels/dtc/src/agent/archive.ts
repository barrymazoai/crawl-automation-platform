import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { sha256, type RetainedPublication } from "@crawl-automation/platform";
import { z } from "zod";
import { dtcAgentErrors } from "./errors.js";

export const CaptureFileSchema = z.strictObject({
  path: z.string(),
  objectKey: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().positive(),
  mediaType: z.string(),
});
export type CaptureFile = z.infer<typeof CaptureFileSchema>;

export async function captureFile(root: string, name: string): Promise<Buffer> {
  const path = resolve(root, name);
  const local = relative(resolve(root), path);
  if (!local || local.startsWith("..") || isAbsolute(local) || (await realpath(path)) !== path) {
    throw dtcAgentErrors.create("DTC.CAPTURE_PATH");
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) {
    throw dtcAgentErrors.create("DTC.CAPTURE_PATH");
  }
  return readFile(path);
}

export async function retainCaptureDirectory(
  publication: RetainedPublication,
  input: {
    root: string;
    prefix: string;
  },
  signal: AbortSignal,
): Promise<CaptureFile[]> {
  const names = await captureNames(input.root);
  const files: CaptureFile[] = [];
  let total = 0;
  for (const path of names) {
    const bytes = await captureFile(input.root, path);
    total += bytes.length;
    if (total > 256 * 1024 * 1024) {
      throw dtcAgentErrors.create("DTC.CAPTURE_LIMIT");
    }
    if (!bytes.length) {
      continue;
    }
    const file = {
      path,
      objectKey: `${input.prefix}/files/${sha256(Buffer.from(path))}`,
      sha256: sha256(bytes),
      byteSize: bytes.length,
      mediaType: captureMime(path),
    };
    await publication.publish(file.objectKey, bytes, file.mediaType, signal);
    files.push(file);
  }
  return files;
}

async function captureNames(root: string): Promise<string[]> {
  const names: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const name = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw dtcAgentErrors.create("DTC.CAPTURE_PATH");
      }
      if (entry.isDirectory()) {
        await walk(name);
      } else {
        names.push(name);
      }
      if (names.length > 1000) {
        throw dtcAgentErrors.create("DTC.CAPTURE_LIMIT");
      }
    }
  }
  await walk("");
  return names.sort();
}

function captureMime(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    svg: "image/svg+xml",
    gif: "image/gif",
    avif: "image/avif",
    html: "text/html",
    json: "application/json",
    jsonl: "application/x-ndjson",
  };
  return types[extension ?? ""] ?? "text/plain";
}
