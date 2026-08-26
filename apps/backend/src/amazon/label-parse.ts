/**
 * 标签图读出来的 JSON → `formula` / `formula_ingredient` 的行。
 *
 * 纯函数，可单测。**剂量数据只能来自标签图** —— 实测页面文本给的是过时版本：
 * 同一个 ASIN，HTML 写 Vitamin D 50%、图上是 75%，还多出 Pygeum、Stinging Nettle
 * 两个图上根本没有的成分。所以这条线不拿 HTML 做任何回退，宁可空着。
 */

import { createHash } from "node:crypto";

export interface LabelJson {
	panelType?:
		| "supplement_facts"
		| "nutrition_facts"
		| "drug_facts"
		| "product_facts";
	skip?: boolean;
	ambiguous?: boolean;
	reason?: string;
	factsImages?: Array<number | string>;
	servingSize?: string | number | Array<string | number | null> | null;
	servingsPerContainer?: number | string | Array<number | string | null> | null;
	activeIngredients?: Array<{
		raw?: string;
		substance?: string | null;
		form?: string | null;
		category?: string | null;
		amount?: string | null;
		dv?: string | null;
		/** 1 = 续行，挂到上一个 indent 更小的行下面（专有配方的子成分） */
		indent?: number;
	}>;
	otherIngredients?: string[];
	unreadable?: string[];
}

export interface FormulaRow {
	rawText: string;
	amountValue: number | null;
	amountUnit: string | null;
	amountMg: number | null;
	dvPercent: number | null;
	position: number;
	isActive: boolean;
	/** 在本数组中的下标；入库时换成真 UUID */
	parentIndex: number | null;
	/** 不参与 formula hash；只用于把 ingredient 挂入分类树。 */
	taxonomy?: {
		substance?: string;
		form?: string;
		category?: string;
	};
}

export interface ParsedLabel {
	servingSize: number | null;
	servingUnit: string | null;
	servingsPerContainer: number | null;
	rows: FormulaRow[];
	hash: string;
}

// ── 数值 ─────────────────────────────────────────────────────────────────

/**
 * 模型经常不按 schema 来：`servingSize` 给数组（套装两张表）、`dv` 给数字 `1`
 * 而不是 `"1%"`。直接 `.trim()` / `.replace()` 会把整条产品当异常丢掉 ——
 * 第二轮 1,997 条里摔了 19 条，原文都在 `label.raw.json` 里。
 *
 * 数组取**第一个**非空字符串。套装本来就两套份量，硬拼会更脏；丢掉整条更亏。
 * 数字只转成字符串，不擅自补 `%`。
 */
export function asLabelText(raw: unknown): string | null {
	if (raw == null || raw === false) return null;
	if (typeof raw === "string") {
		const t = raw.trim();
		return t || null;
	}
	if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
	if (Array.isArray(raw)) {
		for (const item of raw) {
			const s = asLabelText(item);
			if (s) return s;
		}
	}
	return null;
}

/** `"50 mcg"` / `"15mcg"` / `"1.5 g"` → 数值与单位 */
export function parseAmount(
	raw: unknown,
): { value: number; unit: string } | null {
	const text = asLabelText(raw);
	if (!text) return null;
	// ⚠️ 单位后面必须是非字母（词边界）。酶的活性单位 GDU/GaIU/SKB 之类以 g 开头，
	// 不挡的话 `2400 GDU/g` 会被当成 2400 克 —— 实测 26 行酶剂量被放大成
	// 「300,000 mg」级别的鬼数字。挡掉后值保留、单位置空、amount_mg 归 null。
	const m = text
		.replace(/,/g, "")
		.match(
			/(\d+(?:\.\d+)?)\s*(mcg|µg|ug|mg|g|kg|iu|ml|l|billion|million|cfu|%)?(?![A-Za-z])/i,
		);
	if (!m?.[1]) return null;
	const value = Number.parseFloat(m[1]);
	if (!Number.isFinite(value)) return null;
	return { value, unit: m[2] ? m[2].toLowerCase() : "" };
}

/**
 * 归一到毫克，供跨产品比较（"维生素 C ≥ 1000mg" 这类筛选）。
 *
 * ⚠️ **IU 一律返回 null，不要试图换算。** IU→mg 的系数因物质而异
 * （维生素 D 是 0.025 µg/IU，维生素 E 的天然型和合成型还不一样），
 * 拿一个通用系数换出来的是**看起来能比、其实错的**数 —— 比空着更糟。
 * 库里 amount_mg 可空就是留给这种情况的。
 */
export function toMg(value: number, unit: string): number | null {
	switch (unit) {
		case "mg":
			return value;
		case "mcg":
		case "µg":
		case "ug":
			return value / 1000;
		case "g":
			return value * 1000;
		case "kg":
			return value * 1e6;
		default:
			// iu / ml / cfu / billion / 无单位 —— 都换不出可比的质量
			return null;
	}
}

/**
 * `"250%"` → 250；`"†"` / `"*"` → null。
 *
 * ⚠️ **`"<1%"` 这类带上下界的一律返回 null,不要把 `<` 丢掉当成 1。**
 * 数值列表达不了「小于」,存成 1 会让「%DV ≥ 1」这种筛选把它错误地选中 ——
 * 方向性地高估。实测存量里有 803 条 `dv_percent = 1`,其中相当一部分是被吃掉的
 * `<1%`。原始字符串在 `facts_json` 里留着,要还原随时能拿。
 */
export function parseDv(raw: unknown): number | null {
	const text = asLabelText(raw);
	if (!text) return null;
	const t = text.replace(/,/g, "").trim();
	if (/^[<>≤≥]/.test(t)) return null;
	const m = t.match(/(\d+(?:\.\d+)?)\s*%/);
	if (!m?.[1]) return null;
	const v = Number.parseFloat(m[1]);
	return Number.isFinite(v) ? v : null;
}

/**
 * 按**顶层**逗号/分号切分 —— 括号内的逗号不算。
 *
 * 成分名里括号套逗号是常态:`Enzymax® (calcium carbonate, bromelain, papain)`、
 * `Black Cohosh rhizome and root (Cimicifuga racemosa (L.) Nutt.) (4.5-8.5:1)`。
 * 直接 `split(",")` 会把这些合法长名字切碎,比不切还糟。
 */
export function splitTopLevel(text: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = "";
	for (const ch of text) {
		if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
		if ((ch === "," || ch === ";") && depth === 0) {
			out.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) out.push(cur.trim());
	return out.filter(Boolean);
}

/**
 * 判断一行是不是「专有配方底下那一整段子成分」。
 *
 * 标签上这些子成分**本来就是逗号连排的一整段**(核对过原图,模型抄得没错),
 * 但整段当成一个成分名入库会有两个后果:污染 `ingredient` 词表,以及
 * 「哪些产品含 Milk Thistle」这类查询查不出来。所以要拆开挂到 blend 下面。
 *
 * 三个条件缺一不可 —— 只满足长度会误伤上面那种带括号的长学名。
 */
function looksLikeSubIngredientRun(
	rawText: string,
	hasAmount: boolean,
): boolean {
	if (hasAmount) return false; // 有自己的剂量,是独立一行
	if (rawText.length <= 120) return false;
	return splitTopLevel(rawText).length >= 3;
}

/** 顶层的分号/斜杠代表多套方案；括号里的单位换算不算。 */
function hasTopLevelServingAlternative(text: string): boolean {
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		if (ch === "(" || ch === "[") depth++;
		else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
		else if (depth === 0 && (ch === ";" || ch === "；")) return true;
		else if (
			depth === 0 &&
			ch === "/" &&
			/\s/.test(text[i - 1] ?? "") &&
			/\s/.test(text[i + 1] ?? "")
		)
			return true;
	}
	return false;
}

const SAFE_SINGULAR_SERVING_UNIT =
	/^(?:(?:vegetable|veggie|chewable)\s+)?(?:capsule|tablet|softgel|gummy|scoop|teaspoon|tablespoon|tsp\.?|tbsp\.?|drop|packet|stick(?:\s+pack)?|pouch)$/i;

function parseServingNumber(text: string): number | null {
	if (/^\d+\s+\d+\/\d+$/.test(text)) {
		const [whole, fraction] = text.split(/\s+/, 2);
		const [a, b] = (fraction as string).split("/").map(Number);
		const value = Number(whole) + (b ? (a as number) / b : Number.NaN);
		return Number.isFinite(value) ? value : null;
	}
	if (text.includes("/")) {
		const [a, b] = text.split("/").map(Number);
		const value = b ? (a as number) / b : Number.NaN;
		return Number.isFinite(value) ? value : null;
	}
	const value = Number.parseFloat(text);
	return Number.isFinite(value) ? value : null;
}

/** `"3 tablets"` → `{3, "tablets"}`；`"1 Tbsp (15 mL)"` → `{1, "Tbsp"}` */
export function parseServingSize(raw: unknown): {
	value: number | null;
	unit: string | null;
} {
	if (Array.isArray(raw)) {
		const parsed = raw
			.map((item) => parseServingSize(item))
			.filter((item) => item.value != null);
		if (parsed.length === 0) return { value: null, unit: null };
		const keys = new Set(
			parsed.map(
				(item) =>
					`${item.value}|${item.unit?.toLowerCase().replace(/\s+/g, " ").trim() ?? ""}`,
			),
		);
		if (keys.size === 1) return parsed[0] as (typeof parsed)[number];
		return {
			value: null,
			unit:
				raw
					.map((item) => asLabelText(item))
					.filter(Boolean)
					.join("; ") || null,
		};
	}
	const text = asLabelText(raw);
	if (!text) return { value: null, unit: null };
	if (hasTopLevelServingAlternative(text)) return { value: null, unit: text };
	// 模型常把标签原文完整抄成 "approximately 1/2 tsp"、
	// "Just Over One Teaspoon"。这些修饰词不改变可存的基础份量。
	let normalized = text
		.replace(/^serving\s*size\s*:?\s*/i, "")
		.replace(/^per\s+/i, "")
		.replace(
			/^(?:~\s*|approximately\s+|approx(?:imately)?\.?\s+|about\s+|around\s+|just over\s+)/i,
			"",
		)
		.trim();

	const eachMatch = normalized.match(/^each\s+(.+?)\s+contains\s*:?\s*$/i);
	if (eachMatch?.[1] && SAFE_SINGULAR_SERVING_UNIT.test(eachMatch[1].trim())) {
		return { value: 1, unit: eachMatch[1].trim() };
	}

	const fractions: Record<string, string> = {
		"¼": "1/4",
		"½": "1/2",
		"¾": "3/4",
		"⅓": "1/3",
		"⅔": "2/3",
		"⅛": "1/8",
		"⅜": "3/8",
		"⅝": "5/8",
		"⅞": "7/8",
	};
	normalized = normalized
		.replace(
			/(\d)([¼½¾⅓⅔⅛⅜⅝⅞])/g,
			(_, whole, fraction) => `${whole} ${fractions[fraction]}`,
		)
		.replace(/[¼½¾⅓⅔⅛⅜⅝⅞]/g, (fraction) => fractions[fraction] as string)
		.replace(/^(\d+),(\d+)(?=\s|$)/, "$1.$2");

	const m = normalized.match(
		/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)\s*([^(]*)/,
	);
	if (!m) {
		// 英文标签很常见 "One (1) Capsule" / "Four Capsules"。只接受
		// 明确的小整数词，避免把任意营销文案猜成份量。
		const wordMatch = normalized.match(
			/^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:\(\s*(\d+(?:\.\d+)?)\s*\))?\s*([^(]*)/i,
		);
		if (!wordMatch) {
			const unitOnly = normalized.match(/^([^()]*)\s*(?:\([^)]*\))?\s*$/);
			const impliedUnit = unitOnly?.[1]?.trim() ?? "";
			if (impliedUnit && SAFE_SINGULAR_SERVING_UNIT.test(impliedUnit)) {
				return { value: 1, unit: impliedUnit };
			}
			return { value: null, unit: text };
		}
		const values: Record<string, number> = {
			one: 1,
			two: 2,
			three: 3,
			four: 4,
			five: 5,
			six: 6,
			seven: 7,
			eight: 8,
			nine: 9,
			ten: 10,
			eleven: 11,
			twelve: 12,
		};
		const value = values[(wordMatch[1] as string).toLowerCase()] ?? null;
		const repeatedValue = wordMatch[2] ? Number.parseFloat(wordMatch[2]) : null;
		if (repeatedValue != null && repeatedValue !== value) {
			return { value: null, unit: text };
		}
		return { value, unit: (wordMatch[3] ?? "").trim() || null };
	}
	// "1/2" / "1 1/2" 这种分数份量真实存在
	const num = parseServingNumber(m[1] as string);
	const unit = (m[2] ?? "").trim() || null;
	return { value: num, unit };
}

/**
 * 模型虽然按提示应返回 number，实测 2,027 条里有 1,412 条返回字符串。
 * 这里只接收含义唯一的格式；`"30; 90"`（套装两张表）和 `"60 capsules"`
 * （容器数量，不一定等于份数）宁可留空，也不制造一个看似精确的错值。
 */
export function parseServingsPerContainer(raw: unknown): number | null {
	if (Array.isArray(raw)) {
		for (const item of raw) {
			const parsed = parseServingsPerContainer(item);
			if (parsed != null) return parsed;
		}
		return null;
	}
	if (typeof raw === "number") {
		return Number.isInteger(raw) && raw > 0 ? raw : null;
	}
	if (typeof raw !== "string") return null;
	const text = raw.trim().replace(/,/g, "");
	if (text.includes(";")) {
		const values = text
			.split(";")
			.map((item) => parseServingsPerContainer(item));
		if (values.some((value) => value == null)) return null;
		const unique = new Set(values);
		return unique.size === 1 ? (values[0] ?? null) : null;
	}
	const match = text.match(
		/^(?:(?:approximately|approx(?:imately)?\.?|about|around)\s+|~\s*)?(\d+(?:\.\d+)?)\s*(?:servings?(?:\s+per\s+(?:container|bottle|bag|package|pack|pouch|box|jar|tub|carton))?)?\s*(?:\([^)]*\))?$/i,
	);
	if (!match?.[1]) return null;
	const value = Number.parseFloat(match[1]);
	// product.servings_per_container 是 integer；2.5 这类真实但无法无损表达的值
	// 保留在 facts_json，不能靠 PostgreSQL 隐式取整后写成另一个数。
	return Number.isInteger(value) && value > 0 ? value : null;
}

// ── 组装 ─────────────────────────────────────────────────────────────────

/**
 * 内容哈希。同一张配方在多个变体/多个产品上共用一行 `formula` 靠它去重
 * （库里 `formula.hash` 是唯一键）。
 *
 * ⚠️ **不排序**。标签上的行序是配方的一部分，排序会让「同成分不同配比顺序」
 * 的两张标签撞成一条。行序变了就是新版本，本来就该是不同的 formula。
 */
export function formulaHash(p: Omit<ParsedLabel, "hash">): string {
	const body = [
		`serving:${p.servingSize ?? ""}${p.servingUnit ?? ""}`,
		`per:${p.servingsPerContainer ?? ""}`,
		...p.rows.map(
			(r) =>
				`${r.position}|${r.isActive ? "A" : "O"}|${r.rawText.toLowerCase().replace(/\s+/g, " ").trim()}|${r.amountValue ?? ""}${r.amountUnit ?? ""}|${r.dvPercent ?? ""}`,
		),
	].join("\n");
	return createHash("sha256").update(body).digest("hex");
}

/** 最近一个顶层有效成分行的下标 —— 拆出来的子成分挂到它下面 */
function lastTopLevelActive(
	rows: FormulaRow[],
	active: NonNullable<LabelJson["activeIngredients"]>,
): number | null {
	for (let i = rows.length - 1; i >= 0; i--) {
		const r = rows[i] as FormulaRow;
		if (r.isActive && r.parentIndex === null && (active[i]?.indent ?? 0) === 0)
			return i;
	}
	return null;
}

/**
 * Codex 的 JSON → 可入库的行。
 *
 * 返回 null 表示这个产品没有可用的配方（非保健品、或图上没有成分表面板）——
 * 调用方据此跳过，而不是写一条空 formula 进去。
 */
export function parseLabel(json: LabelJson | null): ParsedLabel | null {
	if (!json || json.skip || json.ambiguous) return null;
	const active = json.activeIngredients ?? [];
	const other = json.otherIngredients ?? [];
	if (active.length === 0 && other.length === 0) return null;

	const rows: FormulaRow[] = [];

	for (const it of active) {
		// ⚠️ 必须 String() 兜一层。模型偶尔把 raw 返回成数字或对象（实测 5,035 条
		// 里 21 条，0.8%），直接 .trim() 会抛 "raw.trim is not a function"，
		// 整条产品被当异常丢掉。otherIngredients 那边一开始就兜了，这里漏了。
		const rawText = String(it.raw ?? "").trim();
		if (!rawText) continue;
		const substance = asLabelText(it.substance);
		const form = asLabelText(it.form);
		const category = asLabelText(it.category);
		const taxonomy: NonNullable<FormulaRow["taxonomy"]> = {
			...(substance ? { substance } : {}),
			...(form ? { form } : {}),
			...(category ? { category } : {}),
		};
		const hasTaxonomy = Object.values(taxonomy).some(Boolean);
		const amt = parseAmount(it.amount);
		// 续行挂到最近一个缩进更浅的行上 —— 专有配方的 blend 行带总量，
		// 子成分列在其下
		const indent = it.indent ?? 0;
		let parentIndex: number | null = null;
		if (indent > 0) {
			for (let i = rows.length - 1; i >= 0; i--) {
				const prev = rows[i] as FormulaRow;
				if (prev.isActive && (active[i]?.indent ?? 0) < indent) {
					parentIndex = i;
					break;
				}
			}
		}
		// 整段子成分：拆开挂到上一行（多半是 blend）下面，而不是当成一个成分名
		if (looksLikeSubIngredientRun(rawText, amt != null)) {
			const parent = parentIndex ?? lastTopLevelActive(rows, active);
			for (const part of splitTopLevel(rawText)) {
				if (part.length < 2 || part.length > 200) continue;
				rows.push({
					rawText: part,
					amountValue: null,
					amountUnit: null,
					amountMg: null,
					dvPercent: null,
					position: rows.length,
					isActive: true,
					parentIndex: parent,
				});
			}
			continue;
		}

		rows.push({
			rawText,
			amountValue: amt?.value ?? null,
			amountUnit: amt?.unit || null,
			amountMg: amt ? toMg(amt.value, amt.unit) : null,
			dvPercent: parseDv(it.dv),
			position: rows.length,
			isActive: true,
			parentIndex,
			...(hasTaxonomy ? { taxonomy } : {}),
		});
	}

	// 面板底部的赋形剂 —— 没有剂量，is_active = false
	for (const name of other) {
		const rawText = String(name ?? "").trim();
		if (!rawText) continue;
		rows.push({
			rawText,
			amountValue: null,
			amountUnit: null,
			amountMg: null,
			dvPercent: null,
			position: rows.length,
			isActive: false,
			parentIndex: null,
		});
	}

	if (rows.length === 0) return null;

	const serving = parseServingSize(json.servingSize);
	const base = {
		servingSize: serving.value,
		servingUnit: serving.unit,
		servingsPerContainer: parseServingsPerContainer(json.servingsPerContainer),
		rows,
	};
	return { ...base, hash: formulaHash(base) };
}

/**
 * 可信度打分 —— **不采信模型的自评**。
 *
 * 实测它会一边漏掉整整一列、一边报 `confidence: high`；反过来又会把营销图上
 * 的瓶身角标、希伯来文认证章统统列进 `unreadable`，而成分表本身读得干干净净。
 * 两个方向都不可靠，所以这里只按**能核对的客观信号**扣分。
 */
export function scoreConfidence(json: LabelJson, parsed: ParsedLabel): number {
	let score = 100;
	if (!json.factsImages?.length) score -= 40; // 没认出成分表图
	if (parsed.servingSize == null) score -= 15; // 份量没读到
	if (parsed.servingsPerContainer == null) score -= 5;
	// 有效成分一个都没有 —— 只抄到赋形剂，多半没读到面板
	if (!parsed.rows.some((r) => r.isActive)) score -= 30;
	// 有效成分行里连剂量都没有，说明抄的是宣传语不是面板
	const activeRows = parsed.rows.filter((r) => r.isActive);
	if (activeRows.length > 0 && activeRows.every((r) => r.amountValue == null)) {
		score -= 25;
	}
	return Math.max(0, Math.min(100, score));
}
