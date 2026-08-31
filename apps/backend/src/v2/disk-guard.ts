import { statfs } from "node:fs/promises";
import path from "node:path";

export interface DiskGuardConfig {
  root: string;
  /** 软阈值：低于此可用空间（GB）不再领取新的 capture 目录任务，当前目录继续收尾。 */
  softMinFreeGb: number;
  /** 硬阈值：低于此可用空间（GB）暂停发布新 Capture Batch，原地等待处理线释放空间。 */
  hardMinFreeGb: number;
  pollMs?: number;
  log?: (event: { type: string; freeGb: number; thresholdGb: number }) => void;
}

/**
 * 方案 6：磁盘背压只装在抓取线上。处理/入库/清理线永不装阈值——它们是释放空间的一方。
 * 抓取线正常情况下永远不等待处理线；这是唯一允许它减速的安全例外。
 */
export class DiskGuard {
  constructor(private config: DiskGuardConfig) {}

  async freeGb() {
    // WORK_ROOT 可能尚未创建：回退到上级目录（同一文件系统）。
    let target = this.config.root;
    for (;;) {
      try {
        const stats = await statfs(target);
        return (stats.bavail * stats.bsize) / 1024 ** 3;
      } catch (error) {
        const parent = path.dirname(target);
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === target) throw error;
        target = parent;
      }
    }
  }

  /** 软阈值检查：false 表示不应领取新的 capture 目录任务。 */
  async allowNewCatalog() {
    const freeGb = await this.freeGb();
    const allowed = freeGb >= this.config.softMinFreeGb;
    if (!allowed) this.config.log?.({ type: "disk_backpressure_soft", freeGb, thresholdGb: this.config.softMinFreeGb });
    return allowed;
  }

  /** 硬阈值等待：在发布每个 Batch 前调用，空间不足时轮询等待处理线释放空间。 */
  async waitForPublishAllowance(signal?: AbortSignal) {
    const pollMs = this.config.pollMs ?? 30_000;
    for (;;) {
      if (signal?.aborted) throw new Error("disk guard aborted");
      const freeGb = await this.freeGb();
      if (freeGb >= this.config.hardMinFreeGb) return;
      this.config.log?.({ type: "disk_backpressure_hard", freeGb, thresholdGb: this.config.hardMinFreeGb });
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
