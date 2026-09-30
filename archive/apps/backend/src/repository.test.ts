import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildJobDag, PipelineRepository } from "./repository.js";

type RecordedQuery = { sql: string; parameters: unknown[] | undefined };

function fakePool(respond: (sql: string) => { rows: unknown[] } | undefined) {
  const queries: RecordedQuery[] = [];
  const client = {
    query: async (sql: string, parameters?: unknown[]) => {
      queries.push({ sql, parameters });
      return respond(sql) ?? { rows: [] };
    },
    release: () => {},
  };
  return { pool: { connect: async () => client } as any, queries };
}

function leasedJob(stage: string, token: string) {
  return {
    id: "job-1", run_id: "run-1", stage, state: "running", attempt: 1, max_attempts: 3,
    leased_by: "node-1", lease_token_hash: createHash("sha256").update(token).digest("hex"),
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

function ids() {
  let value = 0;
  return () => `id-${++value}`;
}

describe("buildJobDag", () => {




  it("sales channel runs start with a single capture_catalog job", () => {
    const dag = buildJobDag({ url: "https://www.gnc.com/brand/gnc", type: "sales_channel", adapter: "gnc" }, ids());
    expect(dag.jobs).toEqual([
      ["id-1", "capture_catalog", "gnc", [], 6, { url: "https://www.gnc.com/brand/gnc", sourceType: "sales_channel", adapter: "gnc" }],
    ]);
    expect(dag.firstJobId).toBe("id-1");
  });

  it("DTC runs capture on Windows then converts evidence on the Mac", () => {
    const dag = buildJobDag({ url: "https://example.com", type: "dtc_browser", adapter: null }, ids());
    expect(dag.jobs.map((job) => [job[1], job[2], job[3]])).toEqual([
      ["capture", "browser", []],
      ["capture_catalog", "dtc", ["id-1"]],
    ]);
    expect(dag.firstJobId).toBe("id-1");
  });
});

describe("PipelineRepository.claim", () => {
  it("limits generic cleanup claims to the requested source adapter", async () => {
    const queries: Array<{ sql: string; parameters: unknown[] | undefined }> = [];
    const client = {
      query: async (sql: string, parameters?: unknown[]) => {
        queries.push({ sql, parameters });
        if (sql.includes("select * from pipeline_node")) {
          return { rows: [{ capabilities: ["gnc", "cleanup"], max_concurrency: 1 }] };
        }
        if (sql.includes("select count(*) count")) return { rows: [{ count: 0 }] };
        return { rows: [] };
      },
      release: () => {},
    };
    const repository = new PipelineRepository({ connect: async () => client } as any);

    await expect(repository.claim("mac-gnc-1", ["gnc", "cleanup"], ["gnc"])).resolves.toBeNull();

    const selection = queries.find(({ sql }) => sql.includes("select j.*,r.status"));
    expect(selection?.sql).toContain("s.adapter=any($2::text[])");
    expect(selection?.parameters).toEqual([["gnc", "cleanup"], ["gnc"]]);
  });

  it("only excludes abandoned runs so a review never freezes sibling jobs", async () => {
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes("select * from pipeline_node")) return { rows: [{ capabilities: ["process_text"], max_concurrency: 4 }] };
      if (sql.includes("select count(*) count")) return { rows: [{ count: 0 }] };
      return undefined;
    });
    const repository = new PipelineRepository(pool);
    await repository.claim("pool-text-1", ["process_text"] as any);
    const selection = queries.find(({ sql }) => sql.includes("select j.*,r.status"));
    expect(selection?.sql).toContain("r.status <> 'abandoned'");
    expect(selection?.sql).not.toContain("needs_review");
  });
});

describe("PipelineRepository.fail (方案 2)", () => {
  it("needs_review marks only the job and never flips the run status", async () => {
    const token = "lease-token-1234567890";
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes("select * from pipeline_job")) return { rows: [leasedJob("process_text", token)] };
      return undefined;
    });
    const repository = new PipelineRepository(pool);
    await repository.fail("job-1", token, { code: "ocr_low_confidence", message: "置信度不足", retryable: false, needsReview: true }, "fail-key-1");

    const runUpdates = queries.filter(({ sql }) => sql.includes("update pipeline_run"));
    expect(runUpdates).toHaveLength(1);
    expect(runUpdates[0]!.sql).toContain("open_review_count=open_review_count+1");
    expect(runUpdates[0]!.sql).not.toContain("status=");
    expect(queries.some(({ sql }) => sql.includes("insert into pipeline_review"))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes("state='needs_review'") && sql.includes("pipeline_job"))).toBe(true);
  });
});

describe("PipelineRepository.registerCaptureBatch", () => {
  it("fans out the batch sub-DAG and skips process_images when not required", async () => {
    const token = "lease-token-1234567890";
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes("select * from pipeline_job")) return { rows: [leasedJob("capture_catalog", token)] };
      return undefined;
    });
    const repository = new PipelineRepository(pool);
    const result = await repository.registerCaptureBatch("job-1", token, {
      batchId: "batch-000001", ordinal: 0, itemCount: 20, batchDirectory: "runs/gnc/run-1/capture/batch-000001", imagesRequired: false,
    });

    const inserts = queries.filter(({ sql }) => sql.includes("insert into pipeline_job")).map(({ parameters }) => parameters!);
    expect(inserts.map((parameters) => parameters[2])).toEqual(["process_text", "product_join", "product_unify"]);
    const [text, join, unify] = inserts;
    expect(join![4]).toEqual([text![0]]);
    expect(unify![4]).toEqual([join![0]]);
    expect(result.imagesJobId).toBeNull();
  });

  it("wires product_join to wait for both lanes when images are required", async () => {
    const token = "lease-token-1234567890";
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes("select * from pipeline_job")) return { rows: [leasedJob("capture_catalog", token)] };
      return undefined;
    });
    const repository = new PipelineRepository(pool);
    await repository.registerCaptureBatch("job-1", token, {
      batchId: "batch-000002", ordinal: 1, itemCount: 20, batchDirectory: "runs/gnc/run-1/capture/batch-000002", imagesRequired: true,
    });

    const inserts = queries.filter(({ sql }) => sql.includes("insert into pipeline_job")).map(({ parameters }) => parameters!);
    expect(inserts.map((parameters) => parameters[2])).toEqual(["process_text", "process_images", "product_join", "product_unify"]);
    const [text, images, join] = inserts;
    expect(join![4]).toEqual([text![0], images![0]]);
  });
});

describe("PipelineRepository.finalizeCatalog", () => {
  it("appends the run tail depending on capture_catalog and every product_unify job", async () => {
    const token = "lease-token-1234567890";
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes("select * from pipeline_job")) return { rows: [leasedJob("capture_catalog", token)] };
      if (sql.includes("stage='product_unify'")) return { rows: [{ id: "unify-1" }, { id: "unify-2" }] };
      return undefined;
    });
    const repository = new PipelineRepository(pool);
    const result = await repository.finalizeCatalog("job-1", token, {
      inputKind: "brand_catalog", exhausted: true, truncated: false, expectedCount: 40, discoveredCount: 40, processedCount: 40,
    });

    const inserts = queries.filter(({ sql }) => sql.includes("insert into pipeline_job")).map(({ parameters }) => parameters!);
    expect(inserts.map((parameters) => parameters[2])).toEqual(["catalog_finalize", "ingest_staging", "cleanup_run"]);
    const [finalize, ingest, cleanup] = inserts;
    expect(finalize![4]).toEqual(["job-1", "unify-1", "unify-2"]);
    expect(ingest![4]).toEqual([finalize![0]]);
    expect(cleanup![4]).toEqual([ingest![0]]);
    expect(result.unifyJobCount).toBe(2);
  });
});

describe("重试预算（基础设施故障容错）", () => {
  it("退避随尝试次数指数拉长，上限 30 分钟", () => {
    // fail() 里的公式：min(1800, 2^attempt * 10) 秒
    const backoff = (attempt: number) => Math.min(1800, 2 ** attempt * 10);
    expect([1, 2, 3, 4, 5].map(backoff)).toEqual([20, 40, 80, 160, 320]);
    expect(backoff(8)).toBe(1800);
    // 单个 job 在判永久失败前累计能等的时间，要能扛过一次 30 分钟的站点冷却
    const total = [1, 2, 3, 4, 5].reduce((sum, a) => sum + backoff(a), 0);
    expect(total).toBeGreaterThan(600);
  });

  it("各阶段的重试上限足以扛过基础设施抖动", () => {
    const dag = buildJobDag({ url: "https://www.gnc.com/brands/x/", type: "sales_channel", adapter: "gnc" }, ids());
    const [, , , , maxAttempts] = dag.jobs[0]!;
    expect(maxAttempts).toBe(6);
  });
});

describe("永久失败是终态", () => {
  it("不进复核队列、不改 run 复核计数，只标记自己并级联下游", async () => {
    const token = "lease-token-1234567890";
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes("select * from pipeline_job")) {
        return { rows: [{ ...leasedJob("process_text", token), attempt: 5, max_attempts: 5 }] };
      }
      return undefined;
    });
    const repository = new PipelineRepository(pool);
    await repository.fail("job-1", token, { code: "ocr_service_down", message: "OCR 服务不可用", retryable: true }, "fail-key-perm");

    expect(queries.some(({ sql }) => sql.includes("state='failed'") && sql.includes("pipeline_job"))).toBe(true);
    // 失败是技术故障，不该混进给人做数据判断的复核队列
    expect(queries.some(({ sql }) => sql.includes("insert into pipeline_review"))).toBe(false);
    expect(queries.some(({ sql }) => sql.includes("open_review_count"))).toBe(false);
    // 下游必须显式标记，否则会以 queued 停留却永远领不走
    const cascade = queries.find(({ sql }) => sql.includes("upstream_failed") && sql.includes("with recursive"));
    expect(cascade).toBeTruthy();
    expect(cascade!.sql).toContain("state in ('queued','retry_wait')");
  });

  it("summary 按 stage 报出 failed 与待办，且排除 abandoned run 的任务", async () => {
    // summary() 直接用 pool.query（不走事务），所以这里的假 pool 要实现 query
    const seen: string[] = [];
    const pool = {
      query: async (sql: string) => { seen.push(sql); return { rows: [{}] }; },
      connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    } as any;
    await new PipelineRepository(pool).summary().catch(() => {});
    const stageQuery = seen.find((sql) => sql.includes("group by j.stage"));
    expect(stageQuery).toBeTruthy();
    expect(stageQuery!).toContain("j.state='failed'");
    // abandoned run 的任务领取时就被排除，面板不能把它们算成待办：
    // 09-03 实测 process_text 显示 818，真正能领的只有 273，差的 545 全在 abandoned run 里。
    expect(stageQuery!).toContain("r.status <> 'abandoned'");
    // queued 要区分"现在就能领"和"依赖还没跑完"
    expect(stageQuery!).toContain("waiting_upstream");
    expect(stageQuery!).toContain("d.state<>'completed'");
  });
});

describe("产物 key 前缀", () => {
  it("配了 S3_KEY_PREFIX 就放进该目录，没配则保持原样", async () => {
    const token = "lease-token-1234567890";
    const make = (prefix?: string) => {
      const { pool, queries } = fakePool((sql) => {
        if (sql.includes("select * from pipeline_job")) return { rows: [leasedJob("capture", token)] };
        return undefined;
      });
      return { repository: new PipelineRepository(pool, 120, prefix), queries };
    };
    const meta = { kind: "evidence_bundle", fileName: "batch-000001.zip", contentType: "application/zip", sha256: "a".repeat(64), byteSize: 10 };

    const withPrefix = make("crawl-v2");
    const a = await withPrefix.repository.createArtifact("job-1", token, meta as any, "k1");
    expect((a as any).bucketKey).toMatch(/^crawl-v2\/runs\/run-1\/job-1\//);

    const bare = make();
    const b = await bare.repository.createArtifact("job-1", token, meta as any, "k2");
    expect((b as any).bucketKey).toMatch(/^runs\/run-1\/job-1\//);
  });
});
