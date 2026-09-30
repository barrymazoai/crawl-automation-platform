import { Agent, request, type Dispatcher } from "undici";
import { isAppError, type AppError } from "../errors/app-error.js";
import { scraperApiErrors } from "./scraperapi-errors.js";
import { allowedHop, isRedirect, redirectFacts } from "./scraperapi-redirects.js";
import {
  ScraperApiAccessSchema,
  ScraperApiOptionsSchema,
  allowedTarget,
  parseSettings,
  type ScraperApiAccess,
  type ScraperApiOptions,
} from "./scraperapi-settings.js";

const PROVIDER_URL = "https://api.scraperapi.com/";
/** ScraperAPI may retry on its side for up to 60 s; the whole fetch gets 70 s. */
const TIMEOUT_MS = 70_000;
/** Same-site redirects followed (e.g. Amazon's /dp/<asin> to its slugged address); each one is a paid request. */
const MAX_HOPS = 2;
/** Statuses that are the page's own answer; anything else is a provider failure. */
const PAGE_STATUSES = new Set([200, 404, 410]);

type Answer = Dispatcher.ResponseData;

export interface ScraperApiRequest {
  /** The page address; it must be on one of the allowed sites. */
  target: string;
  options: Partial<ScraperApiOptions>;
  maxBytes: number;
  /** The caller's own error for a page larger than `maxBytes`. */
  tooLarge: () => AppError;
}

export interface ScraperApiPage {
  status: number;
  /** The address the page was finally fetched from (after allowed same-site redirects). */
  url: string;
  contentType: string | null;
  contentEncoding: string | null;
  bytes: Buffer;
  /** Credits ScraperAPI reported for the last request; null when it did not say. */
  creditCost: number | null;
}

const header = (answer: Answer, name: string): string | null => {
  const value = answer.headers[name];
  return Array.isArray(value) ? value.join(",") : (value ?? null);
};

/**
 * ScraperAPI, called through undici: one submission per page (plus at most two same-site redirects), no
 * cookies or credentials forwarded, the key only in the provider address. The provider may retry on its side; this
 * client never does, never rotates a session and never upgrades the options it was given.
 */
export class ScraperApiClient {
  readonly provider = "scraperapi-sync/1";
  readonly #access: ScraperApiAccess;
  readonly #dispatcher: Dispatcher;

  constructor(access: unknown, transport: { dispatcher?: Dispatcher } = {}) {
    this.#access = parseSettings(ScraperApiAccessSchema, access);
    this.#dispatcher = transport.dispatcher ?? new Agent();
  }

  get(page: ScraperApiRequest, outer: AbortSignal): Promise<ScraperApiPage> {
    return this.fetch(page, outer, MAX_HOPS);
  }

  /** One provider submission, with follow_redirect=false; any redirect is refused without another request. */
  getOnce(page: ScraperApiRequest, outer: AbortSignal): Promise<ScraperApiPage> {
    return this.fetch(page, outer, 0);
  }

  private async fetch(page: ScraperApiRequest, outer: AbortSignal, maxHops: number) {
    const options = parseSettings(ScraperApiOptionsSchema, page.options);
    let target = allowedTarget(page.target, this.#access.allowedOrigins);
    outer.throwIfAborted();
    const signal = AbortSignal.any([outer, AbortSignal.timeout(TIMEOUT_MS)]);
    try {
      let answer = await this.send(target, options, signal);
      for (let hop = 0; hop < maxHops && isRedirect(answer.statusCode); hop++) {
        const next = allowedHop(header(answer, "location"), target, this.#access.allowedOrigins);
        if (!next) {
          break;
        }
        await answer.body.dump();
        target = next;
        answer = await this.send(target, options, signal);
      }
      return await this.accept(answer, { target, page });
    } catch (error) {
      throw isAppError(error) ? error : scraperApiErrors.create("SCRAPERAPI.EXECUTION_UNKNOWN");
    }
  }

  private send(target: URL, options: ScraperApiOptions, signal: AbortSignal): Promise<Answer> {
    const headers = { accept: "text/html", "accept-encoding": "identity" };
    const url = providerUrl(this.#access.apiKey, target, options);
    return request(url, { dispatcher: this.#dispatcher, method: "GET", headers, signal });
  }

  /** Refuses provider failures and unverified redirects; otherwise reads the page within its size limit. */
  private async accept(answer: Answer, fetched: { target: URL; page: ScraperApiRequest }) {
    const { target, page } = fetched;
    const refusal = refusalOf(answer, target);
    if (refusal) {
      await answer.body.dump();
      throw refusal;
    }
    return {
      status: answer.statusCode,
      url: target.href,
      contentType: header(answer, "content-type"),
      contentEncoding: header(answer, "content-encoding"),
      bytes: await readWithin(answer, page),
      creditCost: creditCostOf(header(answer, "sa-credit-cost")),
    };
  }
}

/** The provider address: its settings first, the page address last so its query is never read as a setting. */
function providerUrl(apiKey: string, target: URL, options: ScraperApiOptions): URL {
  const url = new URL(PROVIDER_URL);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("country_code", options.countryCode);
  url.searchParams.set("follow_redirect", "false");
  if (options.sessionNumber !== null) {
    url.searchParams.set("session_number", String(options.sessionNumber));
  }
  if (options.render) {
    url.searchParams.set("render", "true");
  }
  if (options.premium) {
    url.searchParams.set("premium", "true");
  }
  url.searchParams.set("url", target.href);
  return url;
}

function refusalOf(answer: Answer, target: URL): AppError | null {
  const status = answer.statusCode;
  if (status === 401) {
    return scraperApiErrors.create("SCRAPERAPI.AUTH");
  }
  if (status === 429) {
    return scraperApiErrors.create("SCRAPERAPI.THROTTLED");
  }
  if (isRedirect(status)) {
    const facts = { status, target: target.href, location: header(answer, "location") };
    return scraperApiErrors.create("SCRAPERAPI.REDIRECT_UNVERIFIED", {
      details: redirectFacts(facts),
    });
  }
  if (!PAGE_STATUSES.has(status)) {
    return scraperApiErrors.create("SCRAPERAPI.PROVIDER_FAILURE", { details: { status } });
  }
  const finalUrl = header(answer, "sa-final-url");
  if (finalUrl && new URL(finalUrl, target).href !== target.href) {
    const facts = { status, target: target.href, finalUrl };
    return scraperApiErrors.create("SCRAPERAPI.REDIRECT_UNVERIFIED", {
      details: redirectFacts(facts),
    });
  }
  return null;
}

async function readWithin(answer: Answer, page: ScraperApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of answer.body as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > page.maxBytes) {
      answer.body.destroy();
      throw page.tooLarge();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function creditCostOf(raw: string | null): number | null {
  const cost = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}
