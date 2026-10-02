import { setInterval } from "node:timers/promises";
import { ignoreAbort, resourceHealthErrors } from "@crawl-automation/platform";
import type {
  ResourceHealthOptions,
  ResourceHealthPorts,
  ResourceHealthReason,
  ResourceHealthTarget,
} from "./health-ports.js";

/** Refreshes only configured, controller-owned rows; a dead monitor is fenced by the stored TTL. */
export class ResourceHealthMonitor {
  constructor(
    private readonly deps: ResourceHealthPorts,
    private readonly options: ResourceHealthOptions,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    try {
      await this.tick(signal);
      for await (const _ of setInterval(this.options.intervalMs, undefined, { signal })) {
        await this.tick(signal);
      }
    } catch (error) {
      ignoreAbort(error);
    } finally {
      await this.stop();
    }
  }

  async tick(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }
    await Promise.all(
      Object.entries(this.options.resources).map(async ([resourceId, target]) => {
        const reason = await this.reason(resourceId, target);
        // A probe that finishes during shutdown must never publish a fresh healthy lease.
        if (!signal.aborted) {
          await this.write(resourceId, reason);
        }
      }),
    );
  }

  async stop(): Promise<void> {
    await Promise.all(
      Object.keys(this.options.resources).map((resourceId) =>
        this.write(resourceId, "monitor_stopping"),
      ),
    );
  }

  private async reason(resourceId: string, target: ResourceHealthTarget) {
    for (const queue of target.taskQueues) {
      const reason = `no_pollers:${queue}` as const;
      const ready = await this.check(resourceId, reason, async () => {
        const pollers = await this.deps.taskQueues.describe(queue, "activity");
        return pollers.length > 0;
      });
      if (!ready) {
        return reason;
      }
    }
    if (target.browser) {
      let reason: string | null = "BROWSER.UNAVAILABLE";
      const ready = await this.check(resourceId, "browser:BROWSER.UNAVAILABLE", async () => {
        reason = this.deps.browser
          ? await this.deps.browser.reason(resourceId)
          : "BROWSER.CONFIG_INVALID";
        return reason === null;
      });
      if (!ready) {
        return `browser:${reason}` as const;
      }
    }
    if (target.ocr && !(await this.check(resourceId, "ocr_unhealthy", () => this.ocrReady()))) {
      return "ocr_unhealthy";
    }
    const diskReady = await this.check(resourceId, "disk_low", async () => {
      return (await this.deps.disk.freeBytes(this.options.diskPath)) >= this.options.minFreeBytes;
    });
    return diskReady ? "ready" : "disk_low";
  }

  private async ocrReady(): Promise<boolean> {
    const result = await this.deps.ocr.health();
    if (result.error) {
      throw resourceHealthErrors.create("RESOURCE_HEALTH.PROBE_FAILED", { cause: result.error });
    }
    return result.healthy;
  }

  private async check(
    resourceId: string,
    reason: ResourceHealthReason,
    probe: () => Promise<boolean>,
  ): Promise<boolean> {
    try {
      return await probe();
    } catch (error) {
      this.deps.log.warn(
        { resourceId, reason, err: error, code: "RESOURCE_HEALTH.PROBE_FAILED" },
        "resource health probe failed",
      );
      return false;
    }
  }

  private async write(resourceId: string, reason: ResourceHealthReason): Promise<void> {
    const controller = this.options.controller;
    try {
      const matched = await this.deps.repository.write({
        resourceId,
        controller,
        healthy: reason === "ready",
        reason,
        ttlMs: reason === "monitor_stopping" ? 0 : this.options.ttlMs,
      });
      if (matched === 0) {
        this.deps.log.warn(
          { resourceId, controller, code: "RESOURCE_HEALTH.CONTROLLER_MISMATCH" },
          "resource health row not owned",
        );
      }
    } catch (error) {
      this.deps.log.error(
        { resourceId, controller, reason, err: error, code: "RESOURCE_HEALTH.WRITE_FAILED" },
        "resource health write failed",
      );
    }
  }
}
