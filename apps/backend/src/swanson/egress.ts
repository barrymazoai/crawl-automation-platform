/**
 * Swanson 的出口轮动。
 *
 * 跟 GNC 的区别只有一点：Swanson 不需要浏览器来抓目录和商品 JSON，所以轮动
 * 只是调一次 Clash 的选择器接口，不用重启 Chrome、不用换 profile，代价接近零。
 *
 * 为什么必须轮动：2026-09-01 实测，43 个商品全压在单个出口上（Swanson专用 是
 * URLTest 组，只挑最快的那个、不轮换），Cloudflare 直接回 429。轮动之后单个
 * 出口承担的量降到 1/28。
 */
import type { ClashControllerSelector } from "../sales-channel-egress/clash-controller.js";

export interface SwansonEgressOptions {
  selector: ClashControllerSelector;
  /** Clash 里的选择组名。 */
  group: string;
  /** 组内节点名，按顺序轮转。 */
  exits: readonly string[];
  /** 每多少个商品换一个出口。 */
  batchSize: number;
  log?: (event: Record<string, unknown>) => void;
}

export class SwansonEgressRotation {
  private index = 0;
  private sinceSwitch = 0;
  private prepared = false;

  constructor(private options: SwansonEgressOptions) {
    if (options.exits.length === 0) throw new Error("swanson_egress_exits_required");
  }

  get current() { return this.options.exits[this.index % this.options.exits.length]!; }

  /** 首次使用前把出口切到当前节点。 */
  async prepare() {
    if (this.prepared) return this.current;
    await this.select(this.current);
    this.prepared = true;
    return this.current;
  }

  /** 每抓完一个商品调用；够一批就换出口。 */
  async recordProduct() {
    this.sinceSwitch += 1;
    if (this.sinceSwitch < this.options.batchSize) return false;
    await this.rotate("batch");
    return true;
  }

  /** 被限流时立即换出口——不必等攒够一批。 */
  async rotateAfterBlock() { await this.rotate("blocked"); }

  private async rotate(reason: "batch" | "blocked") {
    this.index = (this.index + 1) % this.options.exits.length;
    this.sinceSwitch = 0;
    await this.select(this.current);
    this.options.log?.({ type: "swanson_egress_rotated", reason, exit: this.current, index: this.index });
  }

  private async select(exit: string) {
    await this.options.selector.select(this.options.group, exit);
  }
}
