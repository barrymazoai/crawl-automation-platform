import { pageRoundScript, type EgoPages, type EgoSettings } from "@crawl-automation/platform";

/** Store and product rounds share the same fresh ownership checks and stop-proof lifecycle. */
export const storeRoundScript = pageRoundScript;

export class StoreEgoRounds {
  constructor(private readonly deps: { settings: EgoSettings; pages: EgoPages }) {}

  round(body: string, params: object, signal: AbortSignal): Promise<unknown> {
    return this.deps.pages.round(body, params, signal);
  }

  closeTarget(targetId: string, signal: AbortSignal): Promise<void> {
    return this.deps.pages.closeTarget(targetId, signal);
  }
}
