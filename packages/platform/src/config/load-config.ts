import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { z } from "zod";
import { platformErrors } from "../errors/platform-errors.js";

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const GROUP_OR_OTHER_ACCESS = 0o077;

/**
 * Reads a private JSON config file and checks it against a schema. The file must be absolute, not a symlink,
 * a regular file, readable only by its owner, and at most 4 MiB. A wrong config stops the start.
 */
export async function loadConfig<Schema extends z.ZodType>(
  schema: Schema,
  path: string,
): Promise<z.infer<Schema>> {
  const raw = await readPrivateJson(path);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw platformErrors.create("CONFIG.INVALID", {
      details: { path, issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
    });
  }
  return parsed.data;
}

async function readPrivateJson(path: string): Promise<unknown> {
  if (!isAbsolute(path)) {
    throw platformErrors.create("CONFIG.NOT_ABSOLUTE", { details: { path } });
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const sharedWithOthers =
      process.platform !== "win32" && (stat.mode & GROUP_OR_OTHER_ACCESS) !== 0;
    if (!stat.isFile() || sharedWithOthers) {
      throw platformErrors.create("CONFIG.UNSAFE_FILE", { details: { path } });
    }
    if (stat.size > MAX_CONFIG_BYTES) {
      throw platformErrors.create("CONFIG.TOO_LARGE", { details: { path } });
    }
    const text = await handle.readFile({ encoding: "utf8" });
    return JSON.parse(text);
  } finally {
    await handle.close();
  }
}
