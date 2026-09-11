import { z } from "zod";

export const CHANNELS = ["Amazon", "GNC", "Swanson", "DTC"] as const;
export const ZONES = ["Asia/Shanghai", "America/New_York", "UTC"] as const;
export const STAGES = [
  "等待领取",
  "页面抓取",
  "文件 / OCR",
  "数据校验",
  "已完成",
] as const;
export const CLOCK = new Date("2026-09-05T09:40:00Z");
export const STORAGE_KEY = "crawler-v3-heroui-demo:v1";
const BrandSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  company: z.string(),
  externalId: z.string(),
  note: z.string(),
});
const SourceSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  channel: z.enum(CHANNELS),
  url: z.string(),
  region: z.string(),
  enabled: z.boolean(),
});
const ProductSchema = z.object({
  id: z.string(),
  brandId: z.string(),
  sourceId: z.string(),
  name: z.string(),
  variant: z.string(),
  formula: z.string(),
  ingredients: z.string(),
  status: z.enum(["saved", "synced", "unmapped", "review"]),
  error: z.string(),
  day: z.number().int().min(0).max(6),
  artifacts: z.number().int(),
});
const RunSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  sourceSnapshot: SourceSchema,
  step: z.number().int().min(0).max(4),
  trigger: z.string(),
  createdAt: z.string(),
});
const ScheduleSchema = z.object({
  id: z.string(),
  name: z.string(),
  sourceIds: z.array(z.string()).min(1),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  frequency: z.enum(["daily", "weekdays", "weekly"]),
  zone: z.enum(ZONES),
  enabled: z.boolean(),
});
export const StateSchema = z
  .object({
    version: z.literal(1),
    brands: z.array(BrandSchema),
    sources: z.array(SourceSchema),
    products: z.array(ProductSchema),
    runs: z.array(RunSchema),
    schedules: z.array(ScheduleSchema),
  })
  .refine((s) => {
    const brands = new Set(s.brands.map((b) => b.id)),
      sources = new Set(s.sources.map((src) => src.id));
    return (
      brands.size === s.brands.length &&
      sources.size === s.sources.length &&
      s.sources.every((src) => brands.has(src.brandId)) &&
      s.products.every(
        (p) => brands.has(p.brandId) && sources.has(p.sourceId),
      ) &&
      s.runs.every((r) => sources.has(r.sourceId)) &&
      s.schedules.every((plan) => plan.sourceIds.every((id) => sources.has(id)))
    );
  }, "演示数据关联不完整");
export type Brand = z.infer<typeof BrandSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type Run = z.infer<typeof RunSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type DemoState = z.infer<typeof StateSchema>;
export type Channel = Source["channel"];
export type ResultFilter = "all" | Product["status"];
export const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export function seed(): DemoState {
  const rows: [string, string, string, Channel[]][] = [
    ["thorne", "Thorne", "Thorne HealthTech", ["Amazon", "DTC"]],
    ["now", "NOW Foods", "NOW Health Group", ["Amazon", "GNC", "Swanson"]],
    [
      "life-extension",
      "Life Extension",
      "Life Extension",
      ["Amazon", "Swanson", "DTC"],
    ],
    ["momentous", "Momentous", "", ["DTC", "Amazon"]],
    ["nordic", "Nordic Naturals", "Nordic Naturals", ["GNC", "DTC"]],
    ["garden", "Garden of Life", "Garden of Life", ["Amazon", "GNC"]],
    ["ag1", "AG1", "", ["DTC"]],
    ["maurten", "Maurten", "", ["DTC"]],
  ];
  const brands = rows.map(([id, name, company]) => ({
    id,
    name,
    company,
    note: "",
    externalId: `demo:${id}`,
  }));
  const sources: Source[] = rows.flatMap(([brandId, , , channels]) =>
    channels.map((channel) => ({
      id: `${brandId}-${channel.toLowerCase()}`,
      brandId,
      channel,
      enabled: true,
      region: "US",
      url: `https://${channel === "DTC" ? brandId : channel.toLowerCase()}.example/brands/${brandId}`,
    })),
  );
  const products: Product[] = Array.from({ length: 36 }, (_, i) => {
    const brand = brands[i % brands.length]!;
    const matching = sources.filter((s) => s.brandId === brand.id),
      source = matching[i % matching.length]!;
    const review = i % 9 === 0;
    return {
      id: `obs-demo-${String(i + 1).padStart(3, "0")}`,
      brandId: brand.id,
      sourceId: source.id,
      name: [
        "Magnesium Bisglycinate",
        "Vitamin D3 + K2",
        "Omega-3",
        "Daily Greens",
        "Creatine Monohydrate",
        "Multi Essentials",
      ][i % 6]!,
      variant: i % 2 ? "60 capsules" : "30 servings",
      formula:
        review && i % 2 === 0
          ? ""
          : "模拟配方：每份 Magnesium 200 mg（不是实际产品数据）",
      ingredients:
        review && i % 2 !== 0
          ? ""
          : "模拟原料：Magnesium bisglycinate, cellulose",
      status: review
        ? "review"
        : !brand.company
          ? "unmapped"
          : i % 3 === 0
            ? "saved"
            : "synced",
      error: review
        ? i % 2 === 0
          ? "VALIDATION.FORMULA_MISSING"
          : "VALIDATION.INGREDIENTS_MISSING"
        : "",
      day: i % 7,
      artifacts: 3 + (i % 4),
    };
  });
  const runs = ["thorne-amazon", "momentous-dtc", "now-gnc"].map(
    (sourceId, index) => ({
      id: `run-demo-${index + 1}`,
      sourceId,
      sourceSnapshot: { ...sources.find((s) => s.id === sourceId)! },
      step: index + 1,
      trigger: index ? "手动采集" : "定时计划",
      createdAt: ["17:22", "17:31", "17:35"][index]!,
    }),
  );
  const schedules: Schedule[] = [
    {
      id: "plan-1",
      name: "核心品牌 · 每日更新",
      sourceIds: ["thorne-amazon", "now-gnc", "life-extension-swanson"],
      time: "09:00",
      frequency: "daily",
      zone: "Asia/Shanghai",
      enabled: true,
    },
    {
      id: "plan-2",
      name: "DTC 官网 · 工作日巡检",
      sourceIds: ["momentous-dtc", "ag1-dtc", "maurten-dtc"],
      time: "02:00",
      frequency: "weekdays",
      zone: "America/New_York",
      enabled: true,
    },
    {
      id: "plan-3",
      name: "Nordic · 周度采集",
      sourceIds: ["nordic-gnc"],
      time: "10:00",
      frequency: "weekly",
      zone: "Asia/Shanghai",
      enabled: false,
    },
  ];
  return { version: 1, brands, sources, products, runs, schedules };
}

export const busy = (s: DemoState, id: string) =>
  s.runs.some((r) => r.sourceId === id && r.step < 4);
export function metrics(s: DemoState) {
  const count = (status: Product["status"]) =>
    s.products.filter((p) => p.status === status).length;
  return {
    brands: s.brands.length,
    sources: s.sources.length,
    active: s.runs.filter((r) => r.step < 4).length,
    saved: s.products.filter((p) => p.status !== "review").length,
    unmapped: count("unmapped"),
    review: count("review"),
    synced: count("synced"),
  };
}
export function safeUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入完整的 http / https 链接。");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("链接不能包含脚本、文件协议或账号密码。");
  url.hash = "";
  return url.href;
}
export function saveBrand(
  s: DemoState,
  input: Pick<Brand, "name" | "company" | "note">,
  id?: string,
) {
  const name = input.name.trim();
  if (!name || name.length > 80)
    throw new Error("请填写 1–80 字的 Brand 名称。");
  if (
    s.brands.some(
      (b) => b.id !== id && b.name.toLowerCase() === name.toLowerCase(),
    )
  )
    throw new Error("同名 Brand 已存在，请先查看已有档案。");
  const current = s.brands.find((b) => b.id === id),
    values = { name, company: input.company.trim(), note: input.note.trim() };
  if (current) {
    Object.assign(current, values);
    return current.id;
  }
  const b = { ...values, id: uid("brand"), externalId: "" };
  s.brands.push(b);
  return b.id;
}
export function saveSource(
  s: DemoState,
  input: Omit<Source, "id" | "enabled">,
  id?: string,
) {
  const values = {
    ...input,
    url: safeUrl(input.url),
    region: input.region.trim(),
  };
  if (!values.region || !s.brands.some((b) => b.id === values.brandId))
    throw new Error("Brand 或站点信息不完整。");
  if (
    s.sources.some(
      (src) =>
        src.id !== id &&
        src.brandId === values.brandId &&
        src.url === values.url,
    )
  )
    throw new Error("这个 Brand 已存在相同链接。");
  const current = s.sources.find((src) => src.id === id);
  if (current) Object.assign(current, values);
  else s.sources.push({ ...values, id: uid("source"), enabled: true });
}
const ImportSchema = z
  .array(
    z.object({
      externalId: z.string().trim().min(1).max(100),
      name: z.string().trim().min(1).max(80),
      company: z.string().max(120).default(""),
      sources: z
        .array(
          z.object({ channel: z.enum(CHANNELS), url: z.string().max(2000) }),
        )
        .max(20)
        .default([]),
    }),
  )
  .min(1)
  .max(200);
export type ImportRow = z.infer<typeof ImportSchema>[number] & {
  action: "create" | "skip" | "conflict";
};
export function previewImport(s: DemoState, text: string): ImportRow[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("JSON 格式不正确，请检查引号和逗号。");
  }
  const parsed = ImportSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "请输入 1–200 条包含 name 和 externalId 的 Brand，可选 sources 数组。",
    );
  const ids = new Set<string>(),
    names = new Set(s.brands.map((b) => b.name.toLowerCase()));
  return parsed.data.map((row) => {
    if (ids.has(row.externalId))
      throw new Error(`导入文件中 externalId 重复：${row.externalId}`);
    ids.add(row.externalId);
    const sources = row.sources.map((src) => ({
      ...src,
      url: safeUrl(src.url),
    }));
    const exists = s.brands.some((b) => b.externalId === row.externalId),
      conflict = names.has(row.name.toLowerCase());
    if (!exists) names.add(row.name.toLowerCase());
    return {
      ...row,
      sources,
      action: exists ? "skip" : conflict ? "conflict" : "create",
    };
  });
}
export function importBrands(s: DemoState, rows: ImportRow[]) {
  let count = 0;
  for (const row of rows.filter((r) => r.action === "create")) {
    // Re-check at commit time; a stale preview must not overwrite another edit.
    if (
      s.brands.some(
        (b) =>
          b.externalId === row.externalId ||
          b.name.toLowerCase() === row.name.toLowerCase(),
      )
    )
      continue;
    const id = uid("brand");
    s.brands.push({
      id,
      name: row.name,
      company: row.company,
      externalId: row.externalId,
      note: "从演示 JSON 导入",
    });
    for (const src of row.sources)
      if (
        !s.sources.some(
          (existing) => existing.brandId === id && existing.url === src.url,
        )
      )
        s.sources.push({
          ...src,
          id: uid("source"),
          brandId: id,
          enabled: true,
          region: "US",
        });
    count++;
  }
  return count;
}
export function startRuns(s: DemoState, ids: string[], trigger = "手动采集") {
  let created = 0,
    skipped = 0;
  for (const id of new Set(ids)) {
    const src = s.sources.find((item) => item.id === id);
    if (!src?.enabled || busy(s, id)) {
      skipped++;
      continue;
    }
    s.runs.unshift({
      id: uid("run"),
      sourceId: id,
      sourceSnapshot: { ...src },
      step: 0,
      trigger,
      createdAt: "17:40",
    });
    created++;
  }
  return { created, skipped };
}
export function advanceRun(s: DemoState, id: string) {
  const run = s.runs.find((r) => r.id === id);
  if (!run || run.step >= 4) return;
  run.step++;
  if (run.step === 4) {
    const b = s.brands.find((b) => b.id === run.sourceSnapshot.brandId)!;
    s.products.unshift({
      id: uid("obs"),
      brandId: b.id,
      sourceId: run.sourceId,
      name: "Demo · 新采集产品",
      variant: "30 servings",
      formula: "演示配方：Vitamin C 100 mg",
      ingredients: "演示原料：Ascorbic acid（非实际产品数据）",
      status: b.company ? "saved" : "unmapped",
      error: "",
      day: 6,
      artifacts: 3,
    });
  }
}
export function saveSchedule(
  s: DemoState,
  values: Omit<Schedule, "id" | "enabled">,
  id?: string,
) {
  const current = s.schedules.find((p) => p.id === id);
  const parsed = ScheduleSchema.safeParse({
    ...values,
    name: values.name.trim(),
    id: current?.id || uid("plan"),
    enabled: current?.enabled ?? true,
  });
  if (!parsed.success || !values.name.trim())
    throw new Error("请填写名称、有效时间，并至少选择一个来源。");
  if (current) Object.assign(current, parsed.data);
  else s.schedules.push(parsed.data);
}
export const frequencyLabel = (f: Schedule["frequency"]) =>
  ({ daily: "每天", weekdays: "工作日", weekly: "每周一" })[f];
export function nextOccurrence(s: Schedule, now = CLOCK) {
  if (!s.enabled) return "已暂停";
  const [hour, minute] = s.time.split(":").map(Number) as [number, number];
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: s.zone,
    hourCycle: "h23",
    hour: "2-digit",
    weekday: "short",
  });
  const start = Math.floor(+now / 3600000) * 3600000 + minute * 60000;
  for (let offset = 0; offset < 192; offset++) {
    const date = new Date(start + offset * 3600000);
    if (date <= now) continue;
    const parts = Object.fromEntries(
      formatter.formatToParts(date).map((p) => [p.type, p.value]),
    );
    const matches =
      s.frequency === "daily" ||
      (s.frequency === "weekdays" &&
        !["Sat", "Sun"].includes(parts.weekday!)) ||
      (s.frequency === "weekly" && parts.weekday === "Mon");
    if (Number(parts.hour) === hour && matches)
      return new Intl.DateTimeFormat("zh-CN", {
        timeZone: s.zone,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(date);
  }
  return "无匹配时间";
}
