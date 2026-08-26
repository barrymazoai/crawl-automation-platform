import { type LabelJson, parseLabel } from "./label-parse.js";

export interface OcrLine {
	text?: string;
	score?: number;
	polygon?: number[][];
}
export interface OcrResponse {
	detector?: string;
	recognizer?: string;
	elapsed_ms?: number;
	line_count?: number;
	text?: string;
	lines?: OcrLine[];
}

export interface IndexedOcrImage {
	/** 商品图片列表里的零基下标，必须原样传给 Codex。 */
	index: number;
	fileName: string;
	response: OcrResponse;
}

export interface StoredLabelVerdict {
	raw: string;
	label: LabelJson;
}

/**
 * 已落盘的肯定判定可以直接补入库；明确否定判定跳过；损坏或未解析成功的文件重跑。
 */
export function classifyStoredLabelVerdict(
	value: unknown,
): StoredLabelVerdict | "skip" | null {
	if (!value || typeof value !== "object") return null;
	const saved = value as { raw?: unknown; parsed?: unknown };
	if (!saved.parsed || typeof saved.parsed !== "object") return null;
	const label = saved.parsed as LabelJson;
	if (label.skip || label.ambiguous) return "skip";
	if (!parseLabel(label)) return null;
	return {
		raw: typeof saved.raw === "string" ? saved.raw : JSON.stringify(label),
		label,
	};
}

const STRONG_FACTS_SIGNAL =
	/\b(?:supplement|nutrition|drug|product)\s+facts\b/i;
const CANADIAN_FACTS_SIGNAL =
	/\beach\s+(?:(?:chewable|vegetable|veggie)\s+)?(?:tablet|capsule|softgel|gummy)\s+contains\b/i;
const MEDICINAL_FACTS_SIGNAL =
	/\b(?:non[-\s]?medicinal|medicinal)\s+ingredients?\b/i;

/**
 * OCR 只负责高召回筛图，不在这里判断具体成分。
 *
 * 标题、加拿大 Each capsule contains、Medicinal Ingredients 任一命中即可；
 * 没有标题时至少要同时出现两个面板结构词，避免营销文案里的单个 “daily value”
 * 把整张图误送给 Codex。
 */
export function hasFactsSignal(response: OcrResponse): boolean {
	const text = (
		response.text ??
		response.lines?.map((line) => line.text ?? "").join("\n") ??
		""
	)
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return false;
	if (
		STRONG_FACTS_SIGNAL.test(text) ||
		CANADIAN_FACTS_SIGNAL.test(text) ||
		MEDICINAL_FACTS_SIGNAL.test(text)
	)
		return true;

	const structuralSignals = [
		/\bserving\s+size\b/i,
		/\bservings?\s+per\s+(?:container|package)\b/i,
		/\bamount\s+per\s+serving\b/i,
		/\b(?:%\s*)?daily\s+value\b/i,
		/\bother\s+ingredients?\b/i,
		/\binactive\s+ingredients?\b/i,
		/\bactive\s+ingredients?\b/i,
	];
	return structuralSignals.filter((pattern) => pattern.test(text)).length >= 2;
}

export function selectFactsOcrImages(
	images: readonly IndexedOcrImage[],
): IndexedOcrImage[] {
	return images.filter((image) => hasFactsSignal(image.response));
}

function topLeft(polygon: number[][] | undefined): { x: number; y: number } {
	if (!polygon?.length) return { x: 0, y: 0 };
	const xs = polygon.map((point) => Number(point[0])).filter(Number.isFinite);
	const ys = polygon.map((point) => Number(point[1])).filter(Number.isFinite);
	return {
		x: xs.length > 0 ? Math.round(Math.min(...xs)) : 0,
		y: ys.length > 0 ? Math.round(Math.min(...ys)) : 0,
	};
}

export function formatOcrImage(image: IndexedOcrImage): string {
	const lines = image.response.lines ?? [];
	const body = lines
		.map((line, lineIndex) => {
			const { x, y } = topLeft(line.polygon);
			const confidence = Number.isFinite(line.score)
				? Number(line.score).toFixed(6)
				: "unknown";
			return `[${lineIndex}][x=${x},y=${y},conf=${confidence}] ${line.text ?? ""}`;
		})
		.join("\n");
	return `IMAGE_INDEX=${image.index} FILE=${image.fileName}\n${body}`.trimEnd();
}

export const OCR_TEXT_LABEL_EXTRACTION_PROMPT = `下面是同一个商品的部分图片经 OCR 得到的文字行。你没有收到图片。
每个区块的 IMAGE_INDEX 是它在商品图片列表里的原始零基下标；factsImages 必须返回这个原始下标，不能按本提示词里的区块顺序重新编号。

只依据 OCR 内容提取 Facts 面板。图片中可能同时出现同一配方的大字版和瓶身小字版，重复内容只能保留一次，不能合并成两套；如果明确是不同配方，返回 ambiguous。

只输出 JSON，不要解释，不要 markdown：
{"panelType":"supplement_facts","factsImages":[0],"servingSize":null,"servingsPerContainer":null,"activeIngredients":[{"raw":"","substance":null,"form":null,"category":null,"amount":null,"dv":null,"indent":0}],"otherIngredients":[],"unreadable":[]}

规则：
- panelType 只能是 supplement_facts、nutrition_facts、drug_facts、product_facts。
- servingSize 与 servingsPerContainer 逐字抄；Suggested Use、Directions、Recommended Dosage 不能代替 Serving Size。
- activeIngredients 仅抄面板活性成分并保持顺序；配方 blend 后的组成说明作为 indent=1 的续行。
- 没有明确 DV 就填 null；Other Ingredients 或 Inactive ingredients 逐项拆开。
- category 只能为 vitamins/minerals/amino_acids_peptides/herbs_botanicals/mushrooms/fatty_acids_lipids/probiotics_prebiotics/enzymes/antioxidants_polyphenols/hormones_precursors/fibers_carbs/proprietary_blends_other 或 null。
- 加拿大或其他无 Facts 标题的标签如果明确写 Each tablet/capsule/chewable tablet/vegetable capsule contains，也视为 supplement_facts；servingSize 可规范成相应的 1 tablet/capsule/chewable tablet/vegetable capsule。NON-MEDICINAL INGREDIENTS 视为 otherIngredients。
- Drug Facts 只取 Active ingredient；Purpose、Uses、Directions 不能当成成分。Product Facts 只取明确列出的 active ingredient。
- OCR 缺字、截断或无法确认时不得猜测，把问题记录到 unreadable。`;

export function buildOcrTextLabelPrompt(
	images: readonly IndexedOcrImage[],
): string {
	return `${OCR_TEXT_LABEL_EXTRACTION_PROMPT}\n\nOCR IMAGES:\n\n${images
		.map(formatOcrImage)
		.join("\n\n")}`;
}

export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!Number.isInteger(concurrency) || concurrency < 1)
		throw new Error("concurrency 必须是正整数");
	const results = new Array<R>(items.length);
	let cursor = 0;
	async function worker() {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			results[index] = await mapper(items[index] as T, index);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, worker),
	);
	return results;
}

class AsyncQueue<T> {
	private readonly values: T[] = [];
	private readonly waiters: Array<(value: T | null) => void> = [];
	private closed = false;

	push(value: T): void {
		if (this.closed) throw new Error("queue 已关闭");
		const waiter = this.waiters.shift();
		if (waiter) waiter(value);
		else this.values.push(value);
	}

	close(): void {
		this.closed = true;
		for (const waiter of this.waiters.splice(0)) waiter(null);
	}

	async shift(): Promise<T | null> {
		const value = this.values.shift();
		if (value !== undefined) return value;
		if (this.closed) return null;
		return new Promise((resolve) => this.waiters.push(resolve));
	}
}

/**
 * 产品级流水线：某个产品 OCR 完成后立即进入 Codex 队列，不等待全量图片。
 * 第一阶段返回 null 表示该产品无需调用 Codex（例如 OCR 未命中 Facts）。
 */
export async function runStreamingPipeline<T, R>(
	items: readonly T[],
	options: { ocrProductConcurrency: number; codexConcurrency: number },
	ocrStage: (item: T, index: number) => Promise<R | null>,
	codexStage: (ready: R) => Promise<void>,
): Promise<void> {
	const queue = new AsyncQueue<R>();
	let cursor = 0;
	let firstError: unknown;

	async function ocrWorker() {
		while (true) {
			const index = cursor++;
			if (index >= items.length) return;
			try {
				const ready = await ocrStage(items[index] as T, index);
				if (ready !== null) queue.push(ready);
			} catch (error) {
				firstError ??= error;
			}
		}
	}

	async function codexWorker() {
		while (true) {
			const ready = await queue.shift();
			if (ready === null) return;
			try {
				await codexStage(ready);
			} catch (error) {
				firstError ??= error;
			}
		}
	}

	const codexWorkers = Array.from(
		{ length: options.codexConcurrency },
		codexWorker,
	);
	await Promise.all(
		Array.from({ length: options.ocrProductConcurrency }, ocrWorker),
	);
	queue.close();
	await Promise.all(codexWorkers);
	if (firstError) throw firstError;
}
