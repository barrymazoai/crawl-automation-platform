import { Parser } from "htmlparser2";
export class ChannelError extends Error { constructor(readonly code: string) { super(code); this.name = "ChannelError"; } }
export type HtmlNode = { tag: string; attrs: Record<string, string>; parent: HtmlNode | null; children: HtmlNode[]; text: string; start: number; end: number };
export const CHANNEL_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, nodes: 100000, depth: 128 });
export function parseHtml(html: string) {
  if (Buffer.byteLength(html) > CHANNEL_LIMITS.bytes) throw new ChannelError("CHANNEL.PAGE_LIMIT");
  const root: HtmlNode = { tag: "root", attrs: {}, parent: null, children: [], text: "", start: 0, end: html.length }, all: HtmlNode[] = [];
  let current = root, depth = 0, count = 0;
  const parser = new Parser({ onopentag(tag, attrs) {
    if (++count > CHANNEL_LIMITS.nodes || ++depth > CHANNEL_LIMITS.depth) throw new ChannelError("CHANNEL.PAGE_LIMIT");
    const n: HtmlNode = { tag, attrs, parent: current, children: [], text: "", start: parser.startIndex, end: html.length };
    current.children.push(n); all.push(n); current = n;
  }, ontext(text) {
    if (++count > CHANNEL_LIMITS.nodes) throw new ChannelError("CHANNEL.PAGE_LIMIT");
    current.children.push({ tag: "#text", attrs: {}, parent: current, children: [], text, start: parser.startIndex, end: parser.endIndex + 1 });
  }, onclosetag() { current.end = parser.endIndex + 1; current = current.parent ?? root; depth--; } }, { decodeEntities: true });
  parser.end(html); return { root, all };
}
export function visibleText(n: HtmlNode): string {
  if (["script", "style", "template", "noscript"].includes(n.tag)) return "";
  return n.tag === "#text" ? n.text : n.children.map(visibleText).join(" ");
}
export const cleanText = (n: HtmlNode) => visibleText(n).replace(/\s+/g, " ").trim();
export function within(n: HtmlNode, predicate: (n: HtmlNode) => boolean): boolean { return predicate(n) || !!n.parent && within(n.parent, predicate); }
export function uniqueId(all: HtmlNode[], id: string) { const ns = all.filter(n => n.attrs.id === id); if (ns.length > 1) throw new ChannelError("CHANNEL.IDENTITY_CONFLICT"); return ns[0] ?? null; }
export function channelUrl(raw: string, channel: "amazon" | "swanson", base?: string) {
  let u: URL; try { u = new URL(raw, base); } catch { throw new ChannelError("CHANNEL.URL_REJECTED"); }
  if (u.protocol !== "https:" || u.hostname !== (channel === "amazon" ? "www.amazon.com" : "www.swansonvitamins.com") || u.port || u.username || u.password || u.hash) throw new ChannelError("CHANNEL.URL_REJECTED");
  return u;
}
export function imageUrl(raw: string, base: string) {
  let u: URL; try { u = new URL(raw, base); } catch { throw new ChannelError("CHANNEL.IMAGE_URL_REJECTED"); }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash || !/^(?:[a-z0-9-]+\.)*(?:media-amazon\.com|ssl-images-amazon\.com|swansonvitamins\.com|shopify\.com)$/.test(u.hostname)) throw new ChannelError("CHANNEL.IMAGE_URL_REJECTED");
  return u.href;
}
export function rejectChallenge(doc: ReturnType<typeof parseHtml>) {
  if (/Robot Check|Sorry, we just need to make sure|Pardon Our Interruption|Access Denied|Verify you are human/i.test(cleanText(doc.root)) || doc.all.some(n => /validateCaptcha/.test(n.attrs.action ?? ""))) throw new ChannelError("CHANNEL.ACCESS_CHALLENGE");
}
