import type { BrowserBrandScanner } from "@crawl-automation/app";
import { channelErrors } from "@crawl-automation/channels-core";

/** URL capabilities keep Store scans separate from this channel's HTTP search/product reader. */
export interface BrowserScanCapability {
  accepts(url: string): boolean;
  scanner: Pick<BrowserBrandScanner, "scan">;
  prepare?(url: string, signal: AbortSignal): Promise<void>;
}

/** A capability is accepted only by its own channel reader's address validation. */
export function acceptsAddress(readers: readonly ((url: string) => unknown)[], url: string) {
  return readers.some((read) => {
    try {
      read(url);
      return true;
    } catch {
      return false;
    }
  });
}

export class BrowserScanners {
  constructor(
    private readonly capabilities: readonly BrowserScanCapability[],
    private readonly refresh?: () => Promise<void>,
  ) {}

  async prepare(url: string, signal: AbortSignal): Promise<void> {
    await this.refresh?.();
    await this.select(url).prepare?.(url, signal);
  }

  async scan(request: Parameters<BrowserBrandScanner["scan"]>[0], signal: AbortSignal) {
    await request.checkpoint?.();
    await this.refresh?.();
    const capability = this.select(request.sourceUrl);
    await capability.prepare?.(request.sourceUrl, signal);
    return capability.scanner.scan(request, signal);
  }

  private select(url: string): BrowserScanCapability {
    const matches = this.capabilities.filter((capability) => capability.accepts(url));
    if (matches.length !== 1 || !matches[0]) {
      throw channelErrors.create("CHANNEL.CAPTURE_MODE_UNSUPPORTED", {
        details: { mode: "browser", url, matches: matches.length },
      });
    }
    return matches[0];
  }
}
