import { describe, expect, it, vi } from "vitest";
import { BrandLinkReconciler } from "./reconciler.js";

type Responder = (sql: string, parameters?: unknown[]) => { rows: any[]; rowCount?: number } | undefined;

function pools(control: Responder, product: Responder = () => ({ rows: [] })) {
  const sqls: string[] = [];
  const params: unknown[][] = [];
  const controlPool = {
    query: async (sql: string, parameters?: unknown[]) => {
      sqls.push(sql); if (parameters) params.push(parameters);
      const result = control(sql, parameters);
      return { rows: result?.rows ?? [], rowCount: result?.rowCount ?? result?.rows?.length ?? 0 };
    },
  } as any;
  const productPool = { query: async (sql: string) => ({ rows: product(sql)?.rows ?? [] }) } as any;
  return { controlPool, productPool, sqls, params };
}

const options = { channel: "gnc", catalogMaxAgeMs: 3_600_000, enqueuePerTick: 5, enqueueAmbiguous: false };
const repository = { createRuns: vi.fn(async () => ({ created: [{ id: "run-1" }], rejected: [] })) } as any;

describe("BrandLinkReconciler", () => {
  it("拒绝写入空目录——空目录会把所有公司误判成渠道上没有", async () => {
    const { controlPool, productPool } = pools(() => ({ rows: [] }));
    const reconciler = new BrandLinkReconciler(controlPool, productPool, repository, options);
    await expect(reconciler.ingestCatalog("gnc", [], null)).rejects.toThrow(/拒绝写入/);
  });

  it("已经有目录刷新任务在排队时不再重复排——否则 30 秒一轮会堆出成百上千个", async () => {
    const { controlPool, productPool, sqls } = pools((sql) => {
      if (sql.includes("channel_catalog_snapshot where channel")) return { rows: [] };
      if (sql.includes("j.stage='resolve_brand_catalog'") && sql.includes("state in")) return { rows: [{ "?column?": 1 }] };
      return { rows: [] };
    });
    await new BrandLinkReconciler(controlPool, productPool, repository, options).tick();
    expect(sqls.some((sql) => sql.includes("insert into pipeline_job"))).toBe(false);
  });

  it("目录快照缺失时排一个刷新任务，交给持有出口浏览器的抓取池", async () => {
    const { controlPool, productPool, sqls } = pools((sql) => {
      if (sql.includes("channel_catalog_snapshot where channel")) return { rows: [] };
      if (sql.includes("j.stage='resolve_brand_catalog'") && sql.includes("state in")) return { rows: [] };
      if (sql.includes("insert into pipeline_source")) return { rows: [{ id: "source-1" }] };
      return { rows: [] };
    });
    await new BrandLinkReconciler(controlPool, productPool, repository, options).tick();
    const insert = sqls.find((sql) => sql.includes("insert into pipeline_job"));
    expect(insert).toContain("resolve_brand_catalog");
  });

  it("抓不全的目录直接丢弃，绝不拿半份目录去比对", async () => {
    const events: any[] = [];
    const { controlPool, productPool, sqls } = pools((sql) => {
      if (sql.includes("j.stage='resolve_brand_catalog'") && sql.includes("state='completed'")) {
        return { rows: [{ id: "job-9", output: { channel: "gnc", complete: false, entries: [{ slug: "a", label: "A" }] } }] };
      }
      if (sql.includes("select job_id from channel_catalog_snapshot")) return { rows: [{ job_id: null }] };
      if (sql.includes("channel_catalog_snapshot where channel")) return { rows: [] };
      if (sql.includes("insert into pipeline_source")) return { rows: [{ id: "source-1" }] };
      return { rows: [] };
    });
    await new BrandLinkReconciler(controlPool, productPool, repository, options, (e) => events.push(e)).tick();
    expect(sqls.some((sql) => sql.includes("insert into channel_brand_catalog"))).toBe(false);
    expect(events.some((e) => e.type === "brand_catalog_incomplete_ignored")).toBe(true);
  });

  it("解析出一个就排一个抓取任务，并写上 enqueued_at 防止重复入队", async () => {
    const captured = new Date();
    const { controlPool, productPool, sqls, params } = pools((sql) => {
      if (sql.includes("j.stage='resolve_brand_catalog'")) return { rows: [] };
      if (sql.includes("channel_catalog_snapshot where channel")) return { rows: [{ entry_count: 272, captured_at: captured }] };
      if (sql.includes("from channel_brand_catalog")) return { rows: [{ slug: "alani-nu", label: "Alani Nu" }] };
      if (sql.includes("select company_id from channel_brand_link")) return { rows: [] };
      if (sql.includes("where channel=$1 and status = any")) {
        return { rows: [{ company_id: "c-1", brand_url: "https://www.gnc.com/brands/alani-nu/" }] };
      }
      return { rows: [] };
    }, () => ({ rows: [{ id: "c-1", name: "Alani Nutrition LLC", canonical_name: "Alani Nu" }] }));

    const result = await new BrandLinkReconciler(controlPool, productPool, repository, options).tick();
    expect(result).toEqual({ matched: 1, enqueued: 1 });
    expect(repository.createRuns).toHaveBeenCalledWith(expect.objectContaining({ urls: ["https://www.gnc.com/brands/alani-nu/"] }));
    expect(sqls.some((sql) => sql.includes("set enqueued_at=now()"))).toBe(true);
    // 匹配结论必须带上目录版本，否则目录更新后无从判断哪些公司该重算
    const upsert = params.find((p) => p.length === 10 && p[0] === "c-1");
    expect(upsert?.[3]).toBe("resolved");
    expect(upsert?.[9]).toEqual(captured);
  });

  it("subset 档默认不自动入队，留给人工确认", async () => {
    const captured = new Date();
    const { controlPool, productPool, params } = pools((sql) => {
      if (sql.includes("j.stage='resolve_brand_catalog'")) return { rows: [] };
      if (sql.includes("channel_catalog_snapshot where channel")) return { rows: [{ entry_count: 272, captured_at: captured }] };
      if (sql.includes("from channel_brand_catalog")) return { rows: [{ slug: "ancient-nutrition", label: "Ancient Nutrition" }] };
      if (sql.includes("select company_id from channel_brand_link")) return { rows: [] };
      return { rows: [] };
    }, () => ({ rows: [{ id: "c-2", name: "Ancient Bliss", canonical_name: null }] }));

    await new BrandLinkReconciler(controlPool, productPool, repository, options).tick();
    const enqueueParams = params.find((p) => Array.isArray(p[1]) && (p[1] as string[]).includes("resolved"));
    expect(enqueueParams?.[1]).toEqual(["resolved"]);
  });
});
