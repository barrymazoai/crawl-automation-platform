import { describe, expect, it } from "vitest";
import {
	buildOcrTextLabelPrompt,
	classifyStoredLabelVerdict,
	hasFactsSignal,
	mapWithConcurrency,
	runStreamingPipeline,
	selectFactsOcrImages,
} from "./ocr-label-pipeline";

describe("classifyStoredLabelVerdict", () => {
	it("直接续跑已解析的肯定判定，跳过明确否定判定", () => {
		const parsed = {
			panelType: "supplement_facts" as const,
			activeIngredients: [{ raw: "Vitamin C", amount: "100 mg", indent: 0 }],
		};
		expect(classifyStoredLabelVerdict({ raw: "saved", parsed })).toMatchObject({
			raw: "saved",
			label: parsed,
		});
		expect(classifyStoredLabelVerdict({ parsed: { ambiguous: true } })).toBe(
			"skip",
		);
	});

	it("损坏或未解析成功的文件会重新处理", () => {
		expect(classifyStoredLabelVerdict(null)).toBeNull();
		expect(classifyStoredLabelVerdict({ raw: "bad", parsed: null })).toBeNull();
		expect(
			classifyStoredLabelVerdict({ parsed: { panelType: "supplement_facts" } }),
		).toBeNull();
	});
});
describe("hasFactsSignal", () => {
	it("识别被 OCR 拆成两行的 Supplement Facts", () => {
		expect(
			hasFactsSignal({ text: "Supplement\nFacts\nServing Size 2 Capsules" }),
		).toBe(true);
	});

	it("识别加拿大 Each capsule contains 标签", () => {
		expect(
			hasFactsSignal({
				text: "Each vegetable capsule contains\nMedicinal Ingredients",
			}),
		).toBe(true);
	});

	it("要求至少两个弱结构词，避免单个营销词误报", () => {
		expect(hasFactsSignal({ text: "Supports your daily value goals" })).toBe(
			false,
		);
		expect(
			hasFactsSignal({ text: "Serving Size 1 Scoop\nAmount Per Serving" }),
		).toBe(true);
	});
});

describe("buildOcrTextLabelPrompt", () => {
	it("保留商品图片原始下标、坐标和置信度", () => {
		const images = [
			{
				index: 7,
				fileName: "07.jpg",
				response: {
					text: "Drug Facts",
					lines: [
						{
							text: "Drug Facts",
							score: 0.9876543,
							polygon: [
								[12, 34],
								[80, 34],
								[80, 50],
								[12, 50],
							],
						},
					],
				},
			},
		];
		const prompt = buildOcrTextLabelPrompt(images);
		expect(selectFactsOcrImages(images)).toHaveLength(1);
		expect(prompt).toContain("IMAGE_INDEX=7 FILE=07.jpg");
		expect(prompt).toContain("[0][x=12,y=34,conf=0.987654] Drug Facts");
		expect(prompt).toContain("不能按本提示词里的区块顺序重新编号");
	});
});

describe("mapWithConcurrency", () => {
	it("限制同时运行的图片数并保持结果顺序", async () => {
		let active = 0;
		let maxActive = 0;
		const results = await mapWithConcurrency(
			[0, 1, 2, 3, 4, 5],
			2,
			async (n) => {
				active++;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 2));
				active--;
				return n * 2;
			},
		);
		expect(maxActive).toBe(2);
		expect(results).toEqual([0, 2, 4, 6, 8, 10]);
	});
});

describe("runStreamingPipeline", () => {
	it("首个产品 OCR 完成后立即进入 Codex，不等待后续产品", async () => {
		let releaseSecond!: () => void;
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const codexStarted: string[] = [];
		const run = runStreamingPipeline(
			["first", "second"],
			{ ocrProductConcurrency: 2, codexConcurrency: 1 },
			async (item) => {
				if (item === "second") await secondGate;
				return item;
			},
			async (item) => {
				codexStarted.push(item);
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(codexStarted).toEqual(["first"]);
		releaseSecond();
		await run;
		expect(codexStarted).toEqual(["first", "second"]);
	});
});
