import type { ChannelAdapter, ChannelId } from "./adapter.js";
import type { CaptureMode } from "./capture.js";
import { channelErrors } from "./errors.js";

/** The channels a process can handle. Built once at startup from the adapters it was given. */
export class ChannelRegistry {
  private readonly adapters = new Map<ChannelId, ChannelAdapter>();

  constructor(adapters: readonly ChannelAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) {
        throw channelErrors.create("CHANNEL.DUPLICATE", { details: { channel: adapter.id } });
      }
      this.adapters.set(adapter.id, adapter);
    }
  }

  get(channel: ChannelId): ChannelAdapter {
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      throw channelErrors.create("CHANNEL.UNKNOWN", { details: { channel } });
    }
    return adapter;
  }

  /** The adapter, after checking it can be captured in the configured mode. */
  forCapture(channel: ChannelId, mode: CaptureMode): ChannelAdapter {
    const adapter = this.get(channel);
    if (!adapter.captureModes.includes(mode)) {
      throw channelErrors.create("CHANNEL.CAPTURE_MODE_UNSUPPORTED", {
        details: { channel, mode },
      });
    }
    return adapter;
  }

  channels(): ChannelId[] {
    return [...this.adapters.keys()];
  }
}
