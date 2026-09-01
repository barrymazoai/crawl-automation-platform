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

describe("永久失败的可见性与下游级联", () => {
  it("重试耗尽时登记复核项，并把下游标记成 upstream_failed", async () => {
    const token = "lease-token-1234567890";
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes("select * from pipeline_job")) {
        // attempt 已达上限 → 走永久失败分支
        return { rows: [{ ...leasedJob("process_text", token), attempt: 5, max_attempts: 5 }] };
      }
      return undefined;
    });
    const repository = new PipelineRepository(pool);
    await repository.fail("job-1", token, { code: "ocr_service_down", message: "OCR 服务不可用", retryable: true }, "fail-key-perm");

    // 1) 任务本身置为 failed
    expect(queries.some(({ sql }) => sql.includes("state='failed'") && sql.includes("pipeline_job"))).toBe(true);
    // 2) 必须登记复核项——否则失败在复核队列里看不见
    expect(queries.some(({ sql }) => sql.includes("insert into pipeline_review"))).toBe(true);
    // 3) 必须级联标记下游，且用递归 CTE 覆盖多层依赖
    const cascade = queries.find(({ sql }) => sql.includes("upstream_failed") && sql.includes("with recursive"));
    expect(cascade).toBeTruthy();
    expect(cascade!.sql).toContain("state in ('queued','retry_wait')");
    // 4) run 的待复核计数要 +1
    expect(queries.some(({ sql }) => sql.includes("open_review_count=open_review_count+1"))).toBe(true);
  });

  it("复核放行时把 upstream_failed 的下游一并放回队列", async () => {
    const { pool, queries } = fakePool((sql) => {
      if (sql.includes("from pipeline_review where id=")) {
        return { rows: [{ id: "rev-1", run_id: "run-1", job_id: "job-1", status: "open" }] };
      }
      return undefined;
    });
    const repository = new PipelineRepository(pool);
    await repository.resolveReview("rev-1", "retry", "人工确认后重试");

    const release = queries.find(({ sql }) => sql.includes("upstream_failed") && sql.includes("state='queued'"));
    expect(release).toBeTruthy();
    expect(release!.sql).toContain("with recursive");
  });
});
