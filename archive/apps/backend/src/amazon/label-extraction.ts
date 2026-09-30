import type { LabelJson } from "./label-parse.js";

type LabelModelCall = (input: { prompt: string; tag: string }) => Promise<string>;

export interface StoredRawLabelVerdict {
	raw: string;
	parsed: LabelJson | null;
}

/**
 * 标签提取协议。核心约束是：serving 字段逐字取自同一张面板；不同配方不能合并。
 */
export const LABEL_EXTRACTION_PROMPT = `你会看到同一个商品的多张图片，图片文件名按 00、01、02… 编号。
只依据图片本身回答。不要联网，不要用常识补全，不要从商品名推断。

只输出 JSON，不要任何解释文字：
{
  "panelType": "supplement_facts",
  "factsImages": [],
  "servingSize": null,
  "servingsPerContainer": null,
  "activeIngredients": [{"raw":"Vitamin D3 (as cholecalciferol)","substance":"Vitamin D","form":"Cholecalciferol","category":"vitamins","amount":"15mcg","dv":"75%","indent":0}],
  "otherIngredients": [],
  "unreadable": []
}
要求：
- **先找面板，再判断品类**：逐张检查是否有标题为 Supplement Facts、Nutrition
  Facts、Drug Facts 或 Product Facts 的结构化面板。只要存在其中任何一种，就不能
  因为商品“不是保健品”而 skip；必须继续读取面板。panelType 只能填
  supplement_facts、nutrition_facts、drug_facts、product_facts 之一。
- 四类面板都没有，而且这批图也不是保健品/膳食补充剂/食品（比如笔记本、数据线、
  支架、玩具、器械、宠物用品等），才返回
  {"skip": true, "reason": "非保健品且无 Facts 面板"}，不要输出其他字段。
- **先处理多面板**：如果多张图只是同一配方的重复展示，只选最清晰的一张；
  factsImages 只填该图的**零基数字下标**。如果图片属于套装、不同变体、不同人群，
  且 Serving Size、成分或剂量不同，绝不能合并，直接返回
  {"ambiguous": true, "reason": "多张不同配方，无法映射为单一配方"}。
- factsImages：所选四类 Facts 面板的零基图序数字。
  一张都不是就给空数组。
- servingSize：逐字抄所选面板的 "Serving Size" 行，不要省略，不要改写；
  没有明确文字就给 null。如果面板明确写 "Each tablet/capsule contains" 这类
  单个单位含量，可分别规范成 "1 tablet" / "1 capsule"。Suggested Use、
  Directions、Recommended Dosage 不是 Serving Size，不能拿来代替。
- servingsPerContainer：逐字抄所选面板的 "Servings Per Container/Package" 行；
  面板没写就给 null，不能用瓶装粒数除以建议用量推算。
- activeIngredients：只抄所选成分表面板里的行，按图上顺序。成分名原样抄，
  保留括号里的说明。
- 每个活性成分另给 taxonomy 线索：substance 是标签文字明确指向的标准
  物质，form 是标签明写的化学形式/来源形式；不确定就给 null，不能猜。
- category 只能是以下 slug 之一：vitamins、minerals、amino_acids_peptides、
  herbs_botanicals、mushrooms、fatty_acids_lipids、probiotics_prebiotics、
  enzymes、antioxidants_polyphenols、hormones_precursors、fibers_carbs、
  proprietary_blends_other。无法由标签文字确定就给 null。
- 续行（如 "(standardized to 10% ellagic acid) 60mg"）也算独立一行，indent 填 1。
- 没有 %DV 的行 dv 填 null。
- otherIngredients：所选面板底部 "Other Ingredients:" 后面的赋形剂，逐个拆开。
- Drug Facts：activeIngredients 只抄 "Active ingredient" 区域，amount 抄同一行
  明写的强度；"Purpose"、"Uses"、"Directions" 不能当成成分。"Inactive
  ingredients" 拆入 otherIngredients。Drug Facts 通常没有 Serving Size，保持 null。
- Product Facts：只提取面板明确列为 active ingredient 且带名称的行；如果面板存在
  但没有这种行，仍要保留 panelType 和 factsImages，activeIngredients 给空数组，
  不能把营销文案或 Directions 猜成成分。
- unreadable：**只报所选成分表面板内**被遮挡、反光、裁切而读不全的内容。
  营销图上的角标、认证章、瓶身弧度这些与成分表无关的，一律不要报。`;

/** 取最后一个 JSON；Codex 可能先回显提示词里的示例。 */
export function extractLabelJson(raw: string): LabelJson | null {
	const candidates: LabelJson[] = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i] as string;
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"' && depth > 0) {
			inString = true;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) {
				try {
					const value = JSON.parse(raw.slice(start, i + 1)) as LabelJson;
					if (
						value &&
						typeof value === "object" &&
						("unreadable" in value || "ambiguous" in value || "skip" in value)
					) {
						candidates.push(value);
					}
				} catch {}
				start = -1;
			}
		}
	}
	return candidates.at(-1) ?? null;
}

/**
 * 模型偶尔会给出语义正确但 JSON 语法损坏的 payload（例如 enum 漏引号）。
 * 对这种纯格式错误只重试一次；原始 OCR 提示仍在上下文里，修复模型不能补充新事实。
 */
export async function extractLabelJsonWithRepair(options: {
	prompt: string;
	tag: string;
	runModel: LabelModelCall;
	stored?: StoredRawLabelVerdict | null;
}): Promise<StoredRawLabelVerdict> {
	let raw = options.stored?.raw;
	let parsed = options.stored?.parsed ?? (raw ? extractLabelJson(raw) : null);
	if (!raw) {
		raw = await options.runModel({ prompt: options.prompt, tag: options.tag });
		parsed = extractLabelJson(raw);
	}
	if (parsed) return { raw, parsed };

	const repairPrompt = `${options.prompt}\n\nThe previous payload below was not valid JSON. Repair JSON syntax only. Do not add, remove, infer, or change any facts. Every property name, string, enum slug, and unit must be JSON-quoted. Return one object with one string field named payload, and serialize the repaired JSON object exactly inside payload.\n\nINVALID PREVIOUS PAYLOAD:\n${raw}`;
	const repairedRaw = await options.runModel({ prompt: repairPrompt, tag: `${options.tag}-repair` });
	return { raw: repairedRaw, parsed: extractLabelJson(repairedRaw) };
}

/**
 * 模型偶尔把 00..06 看成 1..7。正常零基下标优先；只有全部越界、且所有数字都
 * 落在 1..N 时才整体减一，避免把合法的 01 静默改指向 00。
 */
export function resolveFactsImageUrls(
	indices: readonly unknown[],
	urls: readonly string[],
): string[] {
	const numbers = indices
		.map(Number)
		.filter((value) => Number.isInteger(value)) as number[];
	const zeroBased = numbers
		.filter((value) => value >= 0 && value < urls.length)
		.map((value) => urls[value] as string);
	if (zeroBased.length > 0) return [...new Set(zeroBased)];
	if (
		numbers.length > 0 &&
		numbers.every((value) => value >= 1 && value <= urls.length)
	) {
		return [...new Set(numbers.map((value) => urls[value - 1] as string))];
	}
	return [];
}
