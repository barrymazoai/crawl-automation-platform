import path from "node:path";
import type { SalesChannelNavigationRotation, SalesChannelEgressPolicy } from "./types.js";
import { SalesChannelEgressState } from "./state.js";

export interface ManagedSalesChannelBrowser {
  cdpUrl: string;
  health(): Promise<boolean>;
  close(): Promise<void>;
}

interface ManagerOptions {
  state: SalesChannelEgressState;
  policies: SalesChannelEgressPolicy[];
  profileRoot: string;
  selectProxy(input: { selector: string; proxyName: string }): Promise<void>;
  startBrowser(input: { channel: string; exitId: string; profileRoot: string }): Promise<ManagedSalesChannelBrowser>;
  onBrowserReady?(browser: ManagedSalesChannelBrowser): void;
}

export class SalesChannelEgressManager {
  private readonly policies = new Map<string, SalesChannelEgressPolicy>();
  private active: { channel: string; exitId: string; browser: ManagedSalesChannelBrowser } | null = null;

  constructor(private readonly options: ManagerOptions) {
    for (const policy of options.policies) {
      if (this.policies.has(policy.channel)) throw new Error(`duplicate_sales_channel_egress_policy:${policy.channel}`);
      options.state.register(policy);
      this.policies.set(policy.channel, policy);
    }
  }

  async prepare(channel: string) {
    const policy = this.policy(channel);
    const selection = this.options.state.current(policy);
    if (!selection) {
      throw new Error(`sales_channel_all_exits_cooling:${channel}:${this.options.state.nextAvailableAt(policy) ?? "unknown"}`);
    }
    await this.ensureBrowser(policy, selection.exit.id);
    return selection;
  }

  rotation(channel: string): SalesChannelNavigationRotation {
    const policy = this.policy(channel);
    return {
      maxFailureRetries: policy.maxFailureRetries,
      shouldRotateBeforeProduct: () => {
        const current = this.options.state.current(policy);
        return Boolean(current && (!this.active || this.active.channel !== channel || this.active.exitId !== current.exit.id));
      },
      rotateAfterBatch: async () => {
        const current = this.options.state.current(policy);
        if (!current) return false;
        await this.ensureBrowser(policy, current.exit.id);
        return true;
      },
      rotateAfterFailure: async (reason) => {
        if (!this.active || this.active.channel !== channel) throw new Error(`sales_channel_browser_not_prepared:${channel}`);
        const transition = this.options.state.recordFailure(policy, this.active.exitId, reason);
        if (!transition.currentExit) return false;
        await this.ensureBrowser(policy, transition.currentExit.id);
        return true;
      },
      recordProductSuccess: () => {
        if (!this.active || this.active.channel !== channel) throw new Error(`sales_channel_browser_not_prepared:${channel}`);
        this.options.state.recordSuccess(policy, this.active.exitId);
      },
    };
  }

  snapshot(channel: string) {
    return this.options.state.snapshot(this.policy(channel));
  }

  async close() {
    const active = this.active;
    this.active = null;
    await active?.browser.close();
  }

  private policy(channel: string) {
    const policy = this.policies.get(channel);
    if (!policy) throw new Error(`missing_sales_channel_egress_policy:${channel}`);
    return policy;
  }

  private async ensureBrowser(policy: SalesChannelEgressPolicy, exitId: string) {
    if (this.active?.channel === policy.channel && this.active.exitId === exitId && await this.active.browser.health()) return;
    const exit = policy.exits.find((candidate) => candidate.id === exitId);
    if (!exit) throw new Error(`missing_sales_channel_egress_exit:${policy.channel}:${exitId}`);
    const previous = this.active;
    this.active = null;
    await previous?.browser.close();
    await this.options.selectProxy({ selector: policy.selector, proxyName: exit.proxyName });
    const profileRoot = path.join(this.options.profileRoot, policy.channel, exit.id);
    const browser = await this.options.startBrowser({ channel: policy.channel, exitId: exit.id, profileRoot });
    this.active = { channel: policy.channel, exitId: exit.id, browser };
    this.options.onBrowserReady?.(browser);
  }
}
