/**
 * 从 Swanson 商品页里取成分表。
 *
 * 成分表既不在 Shopify 的 .js 接口里（那里的 description 只有几百字营销文案），
 * 也不在可选择的 DOM 节点上，而是在页面内嵌的一段 JSON 里，字段名 supplementFacts。
 * 直接按字段名抠比解析 DOM 稳——DOM 结构会随主题改版变，这个字段是数据层的。
 *
 * 拿到 HTML 成分表就不用走 OCR：一次页面请求换掉两三张图的下载和识别。
 * 抠不到时返回 null，交给图片线兜底——跟 GNC 一样的分工。
 */

/** 页面内嵌 JSON 里可能承载成分表的字段名，按可信度排序。 */
const FACT_FIELDS = ["supplementFacts", "nutritionFacts", "productFacts", "drugFacts"] as const;
const INGREDIENT_FIELDS = ["otherIngredients", "ingredients"] as const;

/** 把 JSON 字符串字面量里的转义还原成正常文本。 */
function decode(value: string) {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\\\/g, "\\")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * 抠出某个字段的字符串值。
 *
 * 用手写扫描而不是正则：值里含转义引号（Thera-Blend® (3,000 CU)、w\/Phytase），
 * 简单的 /"field":"(.*?)"/ 会在第一个转义引号处截断。
 */
function readField(html: string, field: string): string | null {
  const key = new RegExp(`["']?${field}["']?\\s*:\\s*"`, "i");
  const match = key.exec(html);
  if (!match) return null;
  let index = match.index + match[0].length;
  let out = "";
  while (index < html.length) {
    const ch = html[index]!;
    if (ch === "\\") { out += ch + (html[index + 1] ?? ""); index += 2; continue; }
    if (ch === '"') break;
    out += ch;
    index += 1;
  }
  const text = decode(out);
  return text.length >= 20 ? text : null;
}

export interface SwansonHtmlFacts {
  /** 成分表正文，喂给语义线与 Facts 解析。 */
  factsText: string;
  /** 抠到的其他成分（辅料）行，若页面单列了这一段。 */
  otherIngredients: string | null;
  /** 命中的字段名，便于排查页面改版。 */
  field: string;
}

export function extractSwansonHtmlFacts(html: string): SwansonHtmlFacts | null {
  for (const field of FACT_FIELDS) {
    const text = readField(html, field);
    if (!text) continue;
    const other = INGREDIENT_FIELDS.map((name) => readField(html, name)).find(Boolean) ?? null;
    return {
      factsText: other && !text.includes(other.slice(0, 40)) ? `${text}\n${other}` : text,
      otherIngredients: other,
      field,
    };
  }
  return null;
}
