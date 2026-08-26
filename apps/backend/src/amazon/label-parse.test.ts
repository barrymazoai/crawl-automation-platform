import { describe, expect, it } from "vitest";
import {
	formulaHash,
	type LabelJson,
	parseAmount,
	parseDv,
	parseLabel,
	parseServingSize,
	parseServingsPerContainer,
	scoreConfidence,
	splitTopLevel,
	toMg,
} from "./label-parse";

describe("parseAmount", () => {
	it("带空格和不带空格都认", () => {
		expect(parseAmount("50 mcg")).toEqual({ value: 50, unit: "mcg" });
		expect(parseAmount("15mcg")).toEqual({ value: 15, unit: "mcg" });
	});

	it("小数和千分位", () => {
		expect(parseAmount("1.5 g")).toEqual({ value: 1.5, unit: "g" });
		expect(parseAmount("1,000 mg")).toEqual({ value: 1000, unit: "mg" });
	});

	it("IU 保留原单位 —— 换算交给 toMg 拒绝", () => {
		expect(parseAmount("2000 IU")).toEqual({ value: 2000, unit: "iu" });
	});

	it("没有单位时单位为空串", () => {
		expect(parseAmount("250")).toEqual({ value: 250, unit: "" });
	});

	it("酶活性单位不当成克 —— GDU/GaIU/SKB 都以 g 开头", () => {
		// 实测 `2400 GDU/g` 被抠成 2400 克（240 万 mg），全库 26 行酶剂量成了鬼数字
		expect(parseAmount("2400 GDU/g")).toEqual({ value: 2400, unit: "" });
		expect(parseAmount("300 GaIU")).toEqual({ value: 300, unit: "" });
		expect(parseAmount("1,000 ALU")).toEqual({ value: 1000, unit: "" });
	});

	it("真正的克照常认 —— 词边界不误伤", () => {
		expect(parseAmount("1.5 g")).toEqual({ value: 1.5, unit: "g" });
		expect(parseAmount("260g")).toEqual({ value: 260, unit: "g" });
	});

	it("空值和纯符号返回 null", () => {
		expect(parseAmount(null)).toBeNull();
		expect(parseAmount("†")).toBeNull();
	});
});
describe("toMg", () => {
	it("常见质量单位换算", () => {
		expect(toMg(50, "mg")).toBe(50);
		expect(toMg(500, "mcg")).toBe(0.5);
		expect(toMg(1.5, "g")).toBe(1500);
	});

	it("µg 和 ug 都当微克", () => {
		expect(toMg(1000, "µg")).toBe(1);
		expect(toMg(1000, "ug")).toBe(1);
	});

	it("IU 返回 null —— 系数因物质而异，硬换出来的是错数", () => {
		expect(toMg(2000, "iu")).toBeNull();
	});

	it("体积和菌落数也换不出质量", () => {
		expect(toMg(15, "ml")).toBeNull();
		expect(toMg(10, "billion")).toBeNull();
		expect(toMg(250, "")).toBeNull();
	});
});

describe("parseDv", () => {
	it("百分数", () => {
		expect(parseDv("250%")).toBe(250);
		expect(parseDv("2941%")).toBe(2941);
	});

	it("未设定日推荐量的符号返回 null", () => {
		expect(parseDv("†")).toBeNull();
		expect(parseDv("*")).toBeNull();
		expect(parseDv(null)).toBeNull();
	});

	it("模型把 %DV 写成数字时不抛，也不擅自当成百分数", () => {
		expect(parseDv(1)).toBeNull();
	});
});

describe("parseServingSize", () => {
	it("拆出数值和单位", () => {
		expect(parseServingSize("3 tablets")).toEqual({
			value: 3,
			unit: "tablets",
		});
	});

	it("括号里的换算不算单位", () => {
		expect(parseServingSize("1 Tbsp (15 mL)")).toEqual({
			value: 1,
			unit: "Tbsp",
		});
	});

	it("分数份量 —— 半片是真实存在的", () => {
		expect(parseServingSize("1/2 tablet")).toEqual({
			value: 0.5,
			unit: "tablet",
		});
	});

	it("空值两个都为 null", () => {
		expect(parseServingSize(null)).toEqual({ value: null, unit: null });
	});

	it("套装 servingSize 是数组时取第一个，不抛", () => {
		expect(parseServingSize(["1 Scoop (30g)", "1 Scoop (5.9g)"])).toEqual({
			value: 1,
			unit: "Scoop",
		});
	});

	it("英文数字和括号数字都能解析", () => {
		expect(parseServingSize("One capsule")).toEqual({
			value: 1,
			unit: "capsule",
		});
		expect(parseServingSize("Four (4) Capsules")).toEqual({
			value: 4,
			unit: "Capsules",
		});
	});

	it("近似词不妨碍读取份量", () => {
		expect(parseServingSize("approximately 1/2 tsp (2.8g)")).toEqual({
			value: 0.5,
			unit: "tsp",
		});
		expect(parseServingSize("Just Over One Teaspoon (5mL)")).toEqual({
			value: 1,
			unit: "Teaspoon",
		});
	});

	it("多张成分表拼在一个字符串时不擅自选一张", () => {
		expect(
			parseServingSize("Image 05: 2 Soft Gels; Image 06: 1 Stick Pack"),
		).toEqual({
			value: null,
			unit: "Image 05: 2 Soft Gels; Image 06: 1 Stick Pack",
		});
	});

	it("接受真实标签里的 per、波浪号、Unicode 分数和小数逗号", () => {
		expect(parseServingSize("per 2 tsp. (7.4 g)")).toEqual({
			value: 2,
			unit: "tsp.",
		});
		expect(parseServingSize("~1 ml (20 drops)")).toEqual({
			value: 1,
			unit: "ml",
		});
		expect(parseServingSize("½ teaspoon (2 g)")).toEqual({
			value: 0.5,
			unit: "teaspoon",
		});
		expect(parseServingSize("0,5 cucharadas (12,5g)")).toEqual({
			value: 0.5,
			unit: "cucharadas",
		});
	});

	it("Serving Size 前缀和 per 单数单位不妨碍解析", () => {
		expect(parseServingSize("Serving Size: 1 Capsule")).toEqual({
			value: 1,
			unit: "Capsule",
		});
		expect(parseServingSize("Per teaspoon (3g)")).toEqual({
			value: 1,
			unit: "teaspoon",
		});
		expect(parseServingSize("Each vegetable capsule contains")).toEqual({
			value: 1,
			unit: "vegetable capsule",
		});
	});

	it("顶层多方案继续拒绝，不能因支持 Unicode 分数而误选第一项", () => {
		expect(parseServingSize("½ Scoop (4g) / 1 Scoop (8g)")).toEqual({
			value: null,
			unit: "½ Scoop (4g) / 1 Scoop (8g)",
		});
		expect(parseServingSize("Ages 1–3: 1mL; Ages 4+: 2mL")).toEqual({
			value: null,
			unit: "Ages 1–3: 1mL; Ages 4+: 2mL",
		});
	});
});

describe("parseServingsPerContainer", () => {
	it("接受数字和纯数字字符串", () => {
		expect(parseServingsPerContainer(90)).toBe(90);
		expect(parseServingsPerContainer("180")).toBe(180);
	});

	it("接受模型常见的近似表达和 servings 后缀", () => {
		expect(parseServingsPerContainer("approx. 60")).toBe(60);
		expect(parseServingsPerContainer("about 945")).toBe(945);
		expect(parseServingsPerContainer("30 servings")).toBe(30);
		expect(parseServingsPerContainer("14 servings per container")).toBe(14);
		expect(parseServingsPerContainer("30 servings per bottle")).toBe(30);
		expect(parseServingsPerContainer("2 servings per package")).toBe(2);
		expect(parseServingsPerContainer("30 (2oz)")).toBe(30);
	});

	it("数组沿用套装策略，取第一个可解析值", () => {
		expect(parseServingsPerContainer([null, "30", "90"])).toBe(30);
	});

	it("多张表给出相同份数时可以安全合并", () => {
		expect(parseServingsPerContainer("30; 30")).toBe(30);
	});

	it("拒绝多值、单位数量、小数、零和非数值，避免编造份数", () => {
		expect(parseServingsPerContainer("30; 90")).toBeNull();
		expect(parseServingsPerContainer("60 capsules")).toBeNull();
		expect(
			parseServingsPerContainer("about 2.5 servings per container"),
		).toBeNull();
		expect(parseServingsPerContainer(0)).toBeNull();
		expect(parseServingsPerContainer("unknown")).toBeNull();
	});
});

describe("parseLabel", () => {
	/** 取自真实标签 B004KZIKD0（单一成分的维生素 D3） */
	const single: LabelJson = {
		factsImages: [1],
		servingSize: "1 Tablet",
		servingsPerContainer: null,
		activeIngredients: [
			{
				raw: "Vitamin D3 (as cholecalciferol) (2000 IU)",
				amount: "50 mcg",
				dv: "250%",
				indent: 0,
			},
		],
		otherIngredients: ["Dicalcium phosphate", "microcrystalline cellulose"],
		unreadable: [],
	};

	it("有效成分和赋形剂分别标记 is_active", () => {
		const p = parseLabel(single);
		expect(p?.rows.map((r) => r.isActive)).toEqual([true, false, false]);
	});

	it("保留模型给出的受约束 taxonomy 线索", () => {
		const p = parseLabel({
			...single,
			activeIngredients: [
				{
					...single.activeIngredients?.[0],
					substance: "Vitamin D",
					form: "Cholecalciferol",
					category: "vitamins",
				},
			],
		});

		expect(p?.rows[0]?.taxonomy).toEqual({
			substance: "Vitamin D",
			form: "Cholecalciferol",
			category: "vitamins",
		});
	});

	it("position 跨两段连续编号", () => {
		expect(parseLabel(single)?.rows.map((r) => r.position)).toEqual([0, 1, 2]);
	});

	it("剂量拆开并归一到毫克", () => {
		const row = parseLabel(single)?.rows[0];
		expect(row?.amountValue).toBe(50);
		expect(row?.amountUnit).toBe("mcg");
		expect(row?.amountMg).toBe(0.05);
		expect(row?.dvPercent).toBe(250);
	});

	it("赋形剂没有剂量", () => {
		const row = parseLabel(single)?.rows[1];
		expect(row?.amountValue).toBeNull();
		expect(row?.amountMg).toBeNull();
	});

	it("skip 的产品返回 null —— 不写空 formula 进库", () => {
		expect(parseLabel({ skip: true, reason: "非保健品" })).toBeNull();
	});

	it("多配方歧义返回 null —— 不把套装的多张表合成一条配方", () => {
		expect(
			parseLabel({
				ambiguous: true,
				reason: "多张不同配方",
				activeIngredients: [{ raw: "Vitamin C", amount: "500 mg" }],
			}),
		).toBeNull();
	});

	it("一行都没有时返回 null", () => {
		expect(
			parseLabel({ activeIngredients: [], otherIngredients: [] }),
		).toBeNull();
	});

	it("raw 不是字符串时不炸 —— 模型偶尔返回数字或对象", () => {
		const p = parseLabel({
			activeIngredients: [
				{ raw: 500 as unknown as string, amount: "500 mg" },
				{ raw: { name: "Zinc" } as unknown as string, amount: "15 mg" },
			],
		});
		expect(p?.rows).toHaveLength(2);
		expect(p?.rows[0]?.rawText).toBe("500");
	});

	it("null 输入不炸", () => {
		expect(parseLabel(null)).toBeNull();
	});

	it("续行挂到上一行下面 —— 专有配方的子成分", () => {
		const p = parseLabel({
			activeIngredients: [
				{ raw: "Proprietary Blend", amount: "500 mg", indent: 0 },
				{ raw: "Spanish moss", amount: "100 mg", indent: 1 },
				{ raw: "Nettle root", amount: "80 mg", indent: 1 },
			],
		});
		expect(p?.rows.map((r) => r.parentIndex)).toEqual([null, 0, 0]);
	});

	it("顶层行的 parentIndex 为 null", () => {
		const p = parseLabel({
			activeIngredients: [
				{ raw: "Vitamin C", amount: "500 mg", indent: 0 },
				{ raw: "Zinc", amount: "15 mg", indent: 0 },
			],
		});
		expect(p?.rows.map((r) => r.parentIndex)).toEqual([null, null]);
	});
});

describe("splitTopLevel —— 括号内的逗号不算", () => {
	it("顶层逗号切开", () => {
		expect(splitTopLevel("Zinc, Gelatin, Rice Flour")).toEqual([
			"Zinc",
			"Gelatin",
			"Rice Flour",
		]);
	});

	it("括号里的逗号不切 —— 否则合法长学名会被切碎", () => {
		expect(
			splitTopLevel(
				"Enzymax® (calcium carbonate, bromelain, papain), stearic acid",
			),
		).toEqual([
			"Enzymax® (calcium carbonate, bromelain, papain)",
			"stearic acid",
		]);
	});

	it("嵌套括号也认", () => {
		expect(
			splitTopLevel(
				"Black Cohosh root (Cimicifuga racemosa (L.) Nutt.) (4.5-8.5:1) extract",
			),
		).toHaveLength(1);
	});

	it("分号同样算顶层分隔", () => {
		expect(splitTopLevel("A; B, C")).toEqual(["A", "B", "C"]);
	});

	it("括号不配对时不炸", () => {
		expect(splitTopLevel("A (B, C")).toEqual(["A (B, C"]);
	});
});

describe("parseDv 的上下界", () => {
	it("`<1%` 返回 null —— 不能把 < 丢掉当成 1", () => {
		// 存成 1 会让「%DV ≥ 1」把它错误选中。实测存量里 803 条 dv=1
		expect(parseDv("<1%")).toBeNull();
	});

	it("`≥50%` 同理", () => {
		expect(parseDv("≥50%")).toBeNull();
	});

	it("普通百分数照常", () => {
		expect(parseDv("250%")).toBe(250);
	});
});

describe("专有配方整段子成分拆分", () => {
	/** 取自真实标签 B0BFJQSJTQ（BIORAY RAYZ），已对照原图核对 */
	const blend = {
		activeIngredients: [
			{ raw: "Proprietary Blend", amount: "720 mg", dv: null, indent: 0 },
			{
				raw: "Fresh Black Walnut Green Hulls, Hericium (Lion's Mane Fruiting Body & Mycelia), Micronized Chlorella, Red Clover Flowering Herb, Wormwood Aerial Parts, Olive Leaf, American Ginseng Root, Clove Bud, Eleuthero Root, Reishi Fruiting Body, Milk Thistle Seed",
				amount: null,
				dv: null,
				indent: 0,
			},
		],
	};

	it("整段被拆成多行，而不是一个成分名", () => {
		const rows = parseLabel(blend)?.rows ?? [];
		expect(rows.length).toBeGreaterThan(5);
		expect(rows.some((r) => r.rawText === "Milk Thistle Seed")).toBe(true);
	});

	it("拆出来的都挂在 blend 下面", () => {
		const rows = parseLabel(blend)?.rows ?? [];
		const children = rows.filter((r) => r.parentIndex !== null);
		expect(children.length).toBeGreaterThan(5);
		expect(new Set(children.map((r) => r.parentIndex))).toEqual(new Set([0]));
	});

	it("blend 自己保留总量", () => {
		const first = parseLabel(blend)?.rows[0];
		expect(first?.rawText).toBe("Proprietary Blend");
		expect(first?.amountValue).toBe(720);
	});

	it("括号内的逗号不拆 —— Lion's Mane 那一项保持完整", () => {
		const rows = parseLabel(blend)?.rows ?? [];
		expect(
			rows.some((r) => r.rawText.startsWith("Hericium (Lion's Mane")),
		).toBe(true);
	});

	it("带自己剂量的长行不拆 —— 那是独立成分不是子成分段", () => {
		const p = parseLabel({
			activeIngredients: [
				{
					raw: "Acerola berry extract (Malpighia punicifolia) standardized to 25% vitamin C, from organic sources, non-GMO verified",
					amount: "250 mg",
					dv: null,
				},
			],
		});
		expect(p?.rows).toHaveLength(1);
	});

	it("短的逗号串不拆 —— 可能就是个带逗号的名字", () => {
		const p = parseLabel({
			activeIngredients: [{ raw: "Vitamin C, buffered", amount: null }],
		});
		expect(p?.rows).toHaveLength(1);
	});
});

describe("formulaHash", () => {
	const base = {
		servingSize: 1,
		servingUnit: "Tablet",
		servingsPerContainer: 90,
		rows: [
			{
				rawText: "Vitamin C",
				amountValue: 500,
				amountUnit: "mg",
				amountMg: 500,
				dvPercent: 556,
				position: 0,
				isActive: true,
				parentIndex: null,
			},
		],
	};

	it("同样内容得同样哈希", () => {
		expect(formulaHash(base)).toBe(formulaHash(structuredClone(base)));
	});

	it("taxonomy 线索不改变配方内容哈希", () => {
		const firstRow = base.rows[0];
		if (!firstRow) throw new Error("测试基线必须包含一条配方成分");
		expect(
			formulaHash({
				...base,
				rows: [
					{
						...firstRow,
						taxonomy: { substance: "Vitamin C", category: "vitamins" },
					},
				],
			}),
		).toBe(formulaHash(base));
	});

	it("大小写和多余空格不影响 —— 同一张标签不该因排版差异裂成两条", () => {
		const b2 = structuredClone(base);
		(b2.rows[0] as { rawText: string }).rawText = "  vitamin   C ";
		expect(formulaHash(b2)).toBe(formulaHash(base));
	});

	it("剂量变了就是新配方", () => {
		const b2 = structuredClone(base);
		(b2.rows[0] as { amountValue: number }).amountValue = 1000;
		expect(formulaHash(b2)).not.toBe(formulaHash(base));
	});

	it("行序变了就是新配方 —— 所以不排序", () => {
		const two = {
			...base,
			rows: [
				{ ...(base.rows[0] as object), rawText: "A", position: 0 },
				{ ...(base.rows[0] as object), rawText: "B", position: 1 },
			],
		} as typeof base;
		const swapped = {
			...base,
			rows: [
				{ ...(base.rows[0] as object), rawText: "B", position: 0 },
				{ ...(base.rows[0] as object), rawText: "A", position: 1 },
			],
		} as typeof base;
		expect(formulaHash(two)).not.toBe(formulaHash(swapped));
	});

	it("份量变了就是新配方", () => {
		expect(formulaHash({ ...base, servingSize: 2 })).not.toBe(
			formulaHash(base),
		);
	});
});

describe("scoreConfidence —— 只按客观信号扣分，不采信模型自评", () => {
	const good: LabelJson = {
		factsImages: [1],
		servingSize: "1 Tablet",
		servingsPerContainer: 90,
		activeIngredients: [{ raw: "Vitamin C", amount: "500 mg", dv: "556%" }],
	};

	it("信息齐全给满分", () => {
		const p = parseLabel(good);
		expect(p && scoreConfidence(good, p)).toBe(100);
	});

	it("模型自报一堆看不清、但客观信号齐全 —— 照样满分", () => {
		// 实测它会把营销图上的瓶身角标、认证章全列进 unreadable，
		// 而成分表本身读得干干净净。跟着它扣分等于把好数据判死。
		const noisy = { ...good, unreadable: ["00图角标被裁", "02图瓶身弧度"] };
		const p = parseLabel(noisy);
		expect(p && scoreConfidence(noisy, p)).toBe(100);
	});

	it("没认出成分表图要扣分", () => {
		const j = { ...good, factsImages: [] };
		const p = parseLabel(j);
		expect(p && scoreConfidence(j, p)).toBeLessThan(70);
	});

	it("只抄到赋形剂 —— 大幅扣分", () => {
		const j: LabelJson = {
			factsImages: [1],
			servingSize: "1 Tablet",
			servingsPerContainer: 90,
			activeIngredients: [],
			otherIngredients: ["cellulose", "silica"],
		};
		const p = parseLabel(j);
		expect(p && scoreConfidence(j, p)).toBeLessThan(75);
	});

	it("有效成分全都没有剂量 —— 多半抄的是宣传语", () => {
		const j: LabelJson = {
			factsImages: [1],
			servingSize: "1 Tablet",
			servingsPerContainer: 90,
			activeIngredients: [{ raw: "Vitamin C", amount: null, dv: null }],
		};
		const p = parseLabel(j);
		expect(p && scoreConfidence(j, p)).toBe(75);
	});
});

describe("模型乱类型也不丢掉整条", () => {
	it("servingSize 数组 + 每瓶份数字符串 + dv 数字 —— 成分行还在", () => {
		const p = parseLabel({
			factsImages: [2, 4],
			servingSize: ["1 Scoop (30g)", "1 Scoop (5.9g)"],
			servingsPerContainer: "30",
			activeIngredients: [
				{ raw: "Calories", amount: "80", dv: 1 as unknown as string },
				{ raw: "Creatine Monohydrate", amount: "5g", dv: null },
			],
		});
		expect(p).not.toBeNull();
		expect(p?.servingSize).toBe(1);
		expect(p?.servingUnit).toBe("Scoop");
		expect(p?.servingsPerContainer).toBe(30);
		expect(p?.rows.map((r) => r.rawText)).toEqual([
			"Calories",
			"Creatine Monohydrate",
		]);
		expect(p?.rows[0]?.dvPercent).toBeNull();
		expect(p?.rows[1]?.amountValue).toBe(5);
	});
});
