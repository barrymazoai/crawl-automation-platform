import { isDeepStrictEqual as equal } from "node:util";
import { ChannelBrandDecisionSchema, ResolveChannelBrandInputSchema, SwansonBrandDirectorySchema,
  type ChannelBrandDecision } from "@crawl-automation/v3-contracts";
import { RetainedPublication, sha256 } from "@crawl-automation/v3-artifacts";
import { ChannelError, channelUrl } from "./html-evidence.js";

export const SWANSON_BRANDS_URL = "https://www.swansonvitamins.com/pages/brands";
/** Keep company words and punctuation. Broader business aliases require explicit input. */
export const normalizedBrandName = (name: string) => name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
export function swansonBrandUrl(raw: string) {
  const u = channelUrl(raw, "swanson");
  if (!/^\/collections\/brand-[a-z0-9-]+$/.test(u.pathname) || u.search) throw new ChannelError("BRAND_LINK.URL_REJECTED");
  return u.href;
}
export function resolveSwansonBrand(raw: unknown, directory: unknown): ChannelBrandDecision {
  const input = ResolveChannelBrandInputSchema.parse(raw);
  if (input.existingUrl) return ChannelBrandDecisionSchema.parse({ status: "resolved", input,
    url: swansonBrandUrl(input.existingUrl), matchedName: null, basis: "existing-source" });
  const d = SwansonBrandDirectorySchema.parse(directory);
  // Validate every candidate before matching, never synthesize a slug or trust off-site links.
  const entries = d.entries.map(e => {
    const u=channelUrl(e.url,"swanson");
    if(!/^\/collections\/[a-z0-9-]+$/.test(u.pathname)||u.search)throw new ChannelError("BRAND_LINK.URL_REJECTED");
    return {name:e.name,url:u.href,isBrand:u.pathname.startsWith("/collections/brand-")};
  }).filter(e=>e.isBrand).map(({name,url})=>({name,url}));
  if (d.searchValue.trim()) return { status: "review", input, code: "BRAND_LINK.DIRECTORY_FILTERED", candidates: [], automaticRetry: false };
  const primary = normalizedBrandName(input.name), names = new Set([primary, ...input.aliases.map(normalizedBrandName)]);
  const candidates = entries.filter(e => names.has(normalizedBrandName(e.name)));
  const distinct = new Map(candidates.map(e => [e.url, e]));
  if (distinct.size !== 1) return { status: "review", input,
    code: distinct.size ? "BRAND_LINK.AMBIGUOUS" : "BRAND_LINK.NOT_FOUND", candidates: [...distinct.values()], automaticRetry: false };
  const match = candidates.find(e => normalizedBrandName(e.name) === primary) ?? candidates[0]!;
  return { status: "resolved", input, url: match.url, matchedName: match.name,
    basis: normalizedBrandName(match.name) === primary ? "exact-name" : "explicit-alias" };
}

/** Retain a revision-bound decision (including passive Review). Replay reads evidence, never browses again. */
export class ChannelBrandResolutions {
  constructor(private readonly publication: RetainedPublication) {}
  async run(raw: unknown, directory: unknown, signal: AbortSignal) {
    const input = ResolveChannelBrandInputSchema.parse(raw), key = `v3/brand-resolutions/${input.operationId}/decision.json`;
    const old = await this.publication.remote.read(key, 2 * 1024 * 1024, signal);
    if (old) {
      const saved = JSON.parse(new TextDecoder().decode(old)), decision = ChannelBrandDecisionSchema.parse(saved.decision);
      if (!equal(decision.input, input)) throw new ChannelError("BRAND_LINK.INPUT_CONFLICT");
      if (!equal(resolveSwansonBrand(input, saved.directory), decision)) throw new ChannelError("BRAND_LINK.EVIDENCE_CONFLICT");
      return { decision, evidenceKey: key, sha256: sha256(old) };
    }
    const snapshot = input.existingUrl ? null : SwansonBrandDirectorySchema.parse(directory);
    const decision = resolveSwansonBrand(input, snapshot), bytes = Buffer.from(JSON.stringify({ decision, directory: snapshot }));
    await this.publication.publish(key, bytes, "application/json", signal);
    return { decision, evidenceKey: key, sha256: sha256(bytes) };
  }
}
