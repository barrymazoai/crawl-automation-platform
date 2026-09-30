/**
 * 独立站商品页里"看一眼"成分表——站点各不相同，不能假定它在哪：
 *   1. 页面里有完整的成分表 HTML（表格，或带 Serving Size 的文本块）→ 直接用，不 OCR
 *   2. 页面里能指认"成分表那张图"（img 的 alt/src/title 含 supplement/nutrition facts/label）→ 只 OCR 这些
 *   3. 都没有 → 画廊逐张 OCR（原有兜底）
 * 这里只做第 1、2 层的识别；识别是通用规则，不写任何站点专属逻辑。
 * 输出的文本格式与 GNC 的 "HTML FACTS TABLE" 一致（Name | Amount | DV 每行），下游同一套解析。
 */
import { parseHTML } from "linkedom";

const FACTS_ANCHOR = /supplement\s*facts|nutrition(?:al)?\s*facts|nutrition(?:al)?\s*information|amount\s*per\s*serving|serving\s*size/i;
const IMAGE_HINT = /supplement[\s_-]*facts|nutrition[\s_-]*facts|nutrition[\s_-]*label|ingredient|facts[\s_-]*panel|\blabel\b|back[\s_-]*of[\s_-]*(?:pack|box|bottle)/i;
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG"]);

function visibleText(node: any): string {
  if (!node) return "";
  if (node.nodeType === 3) return String(node.data ?? "");
  if (node.nodeType === 1 && SKIP_TAGS.has(String(node.tagName).toUpperCase())) return "";
  let out = "";
  for (const child of node.childNodes ?? []) out += visibleText(child);
  return out;
}
const clean = (value: string) => value.replace(/\s+/g, " ").trim();

function serializeTable(table: any): string {
  return [...table.querySelectorAll("tr")]
    .map((row: any) => [...row.querySelectorAll("th,td")].map((cell: any) => clean(visibleText(cell))).filter(Boolean).join(" | "))
    .filter(Boolean)
    .join("\n");
}

/**
 * 真成分表长什么样：多行、每行短、且有相当比例的行带"数量+单位"或 %DV。
 * 没有这道闸时，含 "Serving Size" 字样的整段营销文案会被当成成分表——实测 Amazon 存档里
 * 抠出的所谓"完整成分表"全是产品简介+配料段，一旦误判就会跳过 OCR 拿这堆文字去解析剂量。
 */
const AMOUNT_ROW = /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|ug|g|kg|iu|ml|l|kcal|cal|%|du|hut|fip|agu|cu|spu|alu|lacu|pc|billion|cfu)\b/i;
const DV_ROW = /\d+\s*%/;
function looksLikeFactsRows(text: string): boolean {
  const rows = text.split("\n").map((r) => r.trim()).filter(Boolean);
  if (rows.length < 4) return false;
  const withAmount = rows.filter((r) => AMOUNT_ROW.test(r) || DV_ROW.test(r)).length;
  const shortRows = rows.filter((r) => r.length <= 120).length;
  // 至少 3 行带数量/DV，且这类行占比不低；整段散文会在这里被挡掉（行少、行长、无数量）
  return withAmount >= 3 && withAmount / rows.length >= 0.3 && shortRows / rows.length >= 0.6;
}

/** 非表格写法（div/li 每行一项）：把成分表容器的可见文本按行切出来。 */
function serializeBlock(root: any): string {
  const lines: string[] = [];
  const walk = (node: any) => {
    if (node.nodeType === 3) { const t = clean(String(node.data ?? "")); if (t) lines.push(t); return; }
    if (node.nodeType !== 1 || SKIP_TAGS.has(String(node.tagName).toUpperCase())) return;
    const tag = String(node.tagName).toUpperCase();
    const isRow = /^(LI|TR|P|DIV|DT|DD|SPAN)$/.test(tag);
    if (isRow && !node.querySelector("li,tr,p,div,dt,dd")) { const t = clean(visibleText(node)); if (t) lines.push(t); return; }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(root);
  return lines.join("\n");
}

export interface HtmlFactsExtraction {
  /** "HTML FACTS TABLE\n..." 形式的成分表文本；找不到为 null。 */
  factsText: string | null;
  /** 页面指认的成分表图片（绝对 URL），按出现顺序。 */
  factsImageUrls: string[];
}

export function extractHtmlFacts(html: string, pageUrl: string): HtmlFactsExtraction {
  const { document } = parseHTML(html);
  const absolute = (value: string | null | undefined) => {
    if (!value) return null;
    try { return new URL(value.trim(), pageUrl).toString(); } catch { return null; }
  };

  // 1. 表格：先找含成分表关键词的容器，再取其中最内层的表；没有关键词容器时退化为全页扫描含 Serving Size 的表
  const anchored = [...document.querySelectorAll("table, section, div, article, details")]
    .filter((el: any) => FACTS_ANCHOR.test(clean(visibleText(el)).slice(0, 4000)));
  const tables = [...new Set(anchored.flatMap((el: any) => el.tagName?.toUpperCase() === "TABLE" ? [el] : [...el.querySelectorAll("table")]))]
    .filter((table: any) => !table.querySelector("table"))
    .map(serializeTable)
    .filter((text) => text.length > 20 && FACTS_ANCHOR.test(text) && looksLikeFactsRows(text));
  let factsText: string | null = tables.length ? tables.map((t) => `HTML FACTS TABLE\n${t}`).join("\n\n") : null;

  // 2. 非表格：挑最小的含 "Serving Size" 的容器（很多 Shopify 主题用 div/li 排版）
  if (!factsText) {
    const blocks = anchored
      .filter((el: any) => /serving\s*size/i.test(visibleText(el)) && !el.querySelector("table"))
      .sort((a: any, b: any) => visibleText(a).length - visibleText(b).length);
    for (const block of blocks) {
      const text = serializeBlock(block);
      if (text.length > 40 && text.length < 6000 && /serving\s*size/i.test(text) && looksLikeFactsRows(text)) { factsText = `HTML FACTS TABLE\n${text}`; break; }
    }
  }

  // 3. 页面指认的成分表图片
  const factsImageUrls: string[] = [];
  for (const img of document.querySelectorAll("img, source, a[href]")) {
    const attrs = ["alt", "title", "src", "data-src", "data-srcset", "srcset", "href", "aria-label"]
      .map((name) => img.getAttribute(name) ?? "").join(" ");
    if (!IMAGE_HINT.test(attrs)) continue;
    const srcsetFirst = (img.getAttribute("srcset") ?? img.getAttribute("data-srcset") ?? "").split(",")[0]?.trim().split(" ")[0] || null;
    const raw = img.getAttribute("src") || img.getAttribute("data-src") || srcsetFirst || img.getAttribute("href");
    const url = absolute(raw);
    if (url && /\.(?:png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(url) && !factsImageUrls.includes(url)) factsImageUrls.push(url);
  }
  return { factsText, factsImageUrls };
}
