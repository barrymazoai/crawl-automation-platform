import { access } from "node:fs/promises";
import { recordRecovery } from "../logger/recovery.js";

/** A missing marker is normal; other access failures must remain distinguishable in diagnostics. */
export async function pathAccessible(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    // ENOENT means the optional marker is absent. It does not mask permission or I/O errors.
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      recordRecovery(error, { operation: "file.access" });
    }
    return false;
  }
}
