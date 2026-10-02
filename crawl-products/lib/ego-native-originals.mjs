import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";

/** Append-only engine receipts outside the model's working capture output. The host archives both. */
export async function retainNativeOriginal(workDir, { url, kind, bytes, observation }) {
  const body = Buffer.from(bytes);
  if (!body.length || body.length > 64 * 1024 * 1024) throw new Error("SOURCE.ORIGINAL_SIZE");
  const extension = { html: "html", json: "json", image: "bin", http: "bin", harvest: "json" }[kind];
  if (!extension) throw new Error("SOURCE.ORIGINAL_KIND");
  const sha256 = createHash("sha256").update(body).digest("hex");
  const relativePath = `native-originals/${sha256}.${extension}`;
  const file = join(workDir, relativePath);
  await mkdir(join(workDir, "native-originals"), { recursive: true });
  try {
    await writeFile(file, body, { flag: "wx", mode: 0o400 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || !(await readFile(file)).equals(body)) {
      throw new Error("SOURCE.ORIGINAL_CONFLICT");
    }
  }
  const receipt = { codec: "ego-native-original/1", kind, url, capturedAt: new Date().toISOString(),
    path: relativePath, byteSize: body.length, sha256, ...(observation ? { observation } : {}) };
  await writeFile(join(workDir, "native-originals", `${randomUUID()}.receipt.json`), JSON.stringify(receipt), { flag: "wx", mode: 0o400 });
  return receipt;
}
