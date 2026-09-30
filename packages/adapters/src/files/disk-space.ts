import { statfs } from "node:fs/promises";

/** Bytes available to this process, excluding filesystem blocks reserved for privileged users. */
export class DiskSpace {
  async freeBytes(path: string): Promise<number> {
    const disk = await statfs(path);
    return disk.bavail * disk.bsize;
  }
}
