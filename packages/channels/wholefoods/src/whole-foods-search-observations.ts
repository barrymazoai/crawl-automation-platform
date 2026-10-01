import { errorCodeOf, isAppError } from "@crawl-automation/platform";
import type { ListingScanContext, ListingScanMetrics } from "@crawl-automation/channels-core";
import type { WholeFoodsHttpScanSettings } from "./whole-foods-http-settings.js";
import { wholeFoodsErrors } from "./whole-foods-errors.js";
import { parseWholeFoodsSearchPage } from "./whole-foods-search-page.js";
import {
  wholeFoodsSearchRequest,
  type WholeFoodsSearchTarget,
} from "./whole-foods-search-request.js";

/** The only paid-repeat exception: a valid answer with zero cards AND available count zero. */
export class WholeFoodsSearchObservations {
  readonly attempts: ListingScanMetrics["attempts"] = [];
  cooldownRequested = false;

  constructor(
    private readonly context: ListingScanContext,
    private readonly settings: WholeFoodsHttpScanSettings,
  ) {}

  get credits(): number {
    return this.attempts.reduce((total, attempt) => total + (attempt.creditCost ?? 0), 0);
  }

  async page(target: Omit<WholeFoodsSearchTarget, "attempt">) {
    for (let attempt = 1; attempt <= this.settings.maxEmptyAttempts; attempt++) {
      if (attempt > 1) {
        await this.context.pause(this.settings.emptyPauseMs);
      }
      const page = await this.observe({ ...target, attempt });
      if (page.cards !== 0 || page.statedTotal !== 0) {
        return page;
      }
    }
    this.cooldownRequested = true;
    throw wholeFoodsErrors.create("WHOLEFOODS.EMPTY_EXHAUSTED", {
      details: { cooldownRequested: true, emptyExhausted: true },
    });
  }

  private async observe(target: WholeFoodsSearchTarget) {
    this.context.signal.throwIfAborted();
    const request = wholeFoodsSearchRequest(target, this.settings);
    const attempt: ListingScanMetrics["attempts"][number] = {
      read: target.read,
      page: target.page,
      attempt: target.attempt,
      url: request.url,
      archiveKey: null,
      creditCost: null,
      fromArchive: false,
      empty: null,
      code: null,
    };
    this.attempts.push(attempt);
    try {
      const answer = await this.context.read(request);
      Object.assign(attempt, {
        archiveKey: answer.archiveKey,
        fromArchive: answer.fromArchive,
        creditCost: answer.originalCreditCost ?? answer.creditCost,
      });
      const page = parseWholeFoodsSearchPage({
        body: answer.body,
        page: target.page,
        size: this.settings.size,
      });
      attempt.empty = page.cards === 0 && page.statedTotal === 0;
      return page;
    } catch (error) {
      attempt.code = errorCodeOf(error);
      if (isAppError(error) && typeof error.details.creditCost === "number") {
        attempt.creditCost = error.details.creditCost;
      }
      throw error;
    }
  }
}
