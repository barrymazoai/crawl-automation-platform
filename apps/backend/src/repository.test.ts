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
      ["id-1", "capture_catalog", "gnc", [], 3, { url: "https://www.gnc.com/brand/gnc", sourceType: "sales_channel", adapter: "gnc" }],
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
