import type { BrandEnrichmentRun } from "@crawl-automation/v3-contracts";
import type { Logger } from "@crawl-automation/platform";
// The shared sender of the 「Supply Smart 服务通知」 cards (tools/notify, also used by the regulatory sync).
import { feishuNotifier, type FeishuNotifier } from "../../../../tools/notify/feishu.mjs";

/**
 * KAN-220: a brand request that ran past the timeout is posted to the 「Supply Smart 服务通知」 group. The webhook URL
 * lives in a private file (`webhookFile`) and is never logged; without the file nothing is sent.
 */
export class FeishuBrandIntakeAlerts {
  private notifier: Promise<FeishuNotifier> | undefined;

  constructor(
    private readonly input: {
      webhookFile: string | null | undefined;
      log: Pick<Logger, "warn" | "error">;
      notifier?: (file: string | null | undefined) => Promise<FeishuNotifier>;
    },
  ) {}

  async timedOut(run: BrandEnrichmentRun, timeoutMs: number): Promise<void> {
    const notifier = await (this.notifier ??= (
      this.input.notifier ?? ((file) => feishuNotifier(file, { log: this.input.log }))
    )(this.input.webhookFile));
    const hours = Math.round((timeoutMs / 3_600_000) * 10) / 10;
    const result = await notifier.send({
      title: `品牌补全超时：${run.brandName}`,
      color: "red",
      markdown: [
        `**${run.brandName}** ${run.brandUrl ?? ""}`,
        `已处理超过 ${hours} 小时，请求已标为 failed（原因 Timeout），爬虫 run 已停止。`,
        `- Supply Smart 请求：\`${run.requestId ?? "—"}\``,
        `- 爬虫 run：\`${run.runId}\`，停在 \`${run.stage ?? "unknown"}\``,
        `- 开始于：${run.createdAt.toISOString()}`,
        "后台 Brand enrichment 页可 Retry 或手动 Complete。",
      ].join("\n"),
    });
    if (!result.sent) {
      this.input.log.warn({ runId: run.runId, reason: result.reason }, "timeout card not sent");
    }
  }
}
