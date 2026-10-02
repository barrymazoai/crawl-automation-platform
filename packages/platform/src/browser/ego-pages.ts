import { z } from "zod";
import { egoErrors } from "./ego-errors.js";
import { EgoRunner, EgoFailureSchema, type EgoRoundFailure } from "./ego-runner.js";
import { READ_PAGE_BODY, closeTargetScript, pageRoundScript } from "./ego-script.js";
import { EgoSettingsSchema, type ResolvedEgoSettings } from "./ego-settings.js";
import { ListScrollResultSchema, type ListScroll } from "./list-scroll.js";
export type { ListScroll } from "./list-scroll.js";

export interface BrowserRead {
  url: string;
  /** The element that shows the page has been drawn, e.g. `h1`. */
  readySelector: string;
  timeoutMs: number;
  scroll?: ListScroll;
}

export const BrowserPageSchema = z.object({
  url: z.string().min(1),
  status: z.number().int().nullable(),
  html: z.string(),
  ready: z.boolean(),
  readinessFailure: EgoFailureSchema.nullable().optional(),
  scroll: ListScrollResultSchema,
});

/** A page as the browser drew it, where it ended up, and how its list scrolling ended. */
export type BrowserPage = z.infer<typeof BrowserPageSchema>;

/**
 * Task-owned pages in the crawler's Ego task space: each round opens its own page and closes it, confirmed. The
 * Profile, cookies and every other tab are left as they are; a space the user controls is never taken back.
 */
export class EgoPages {
  readonly provider = "ego-lite/2";
  private readonly settings: ResolvedEgoSettings;
  private readonly runner: EgoRunner;

  constructor(settings: unknown) {
    const parsed = EgoSettingsSchema.safeParse(settings);
    if (!parsed.success) {
      throw egoErrors.create("BROWSER.CONFIG_INVALID", { cause: parsed.error });
    }
    this.settings = parsed.data;
    this.runner = new EgoRunner(parsed.data);
  }

  /** One page read in a fresh task page, which is closed before this returns. */
  async read(request: BrowserRead, signal: AbortSignal): Promise<BrowserPage> {
    const value = await this.round(READ_PAGE_BODY, { read: request }, signal);
    const page = BrowserPageSchema.parse(value);
    // Ego also reports some transport/target failures as plain readiness errors. Do not let
    // a recovered connection turn that partial capture into a content or empty-page verdict.
    if (page.readinessFailure) {
      throw roundFailed(page.readinessFailure);
    }
    if (Buffer.byteLength(page.html) > this.settings.maxHtmlBytes) {
      throw egoErrors.create("BROWSER.PAGE_LIMIT", {
        details: { maxBytes: this.settings.maxHtmlBytes },
      });
    }
    return page;
  }

  /**
   * A channel's own round on a fresh task page (the body sees `task`, `page`, `params`). A failure the body threw
   * with a code comes back as that code in `details.failure`.
   */
  async round(body: string, params: object, signal: AbortSignal): Promise<unknown> {
    const script = pageRoundScript(body, { ...params, taskSpaceId: this.settings.taskSpaceId });
    const result = await this.runner.run(script, signal);
    if (result.failure) {
      throw roundFailed(result.failure);
    }
    return result.value;
  }

  /** Closes one earlier task page that a failed round left open, by its exact target, and confirms it is gone. */
  async closeTarget(targetId: string, signal: AbortSignal): Promise<void> {
    const params = { taskSpaceId: this.settings.taskSpaceId, targetId };
    await this.runner.run(closeTargetScript(params), signal);
  }
}

function roundFailed(failure: EgoRoundFailure) {
  return egoErrors.create("BROWSER.UNAVAILABLE", { cause: failure, details: { failure } });
}
