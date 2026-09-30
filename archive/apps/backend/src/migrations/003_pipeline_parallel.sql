-- v2 并行流水线（PARALLEL_CRAWL_PIPELINE_PLAN.md）：放宽 stage 枚举约束。
-- 保留全部历史 stage 以维持旧行可读；新增 8 个 v2 阶段。
alter table pipeline_job drop constraint if exists pipeline_job_stage_check;
alter table pipeline_job add constraint pipeline_job_stage_check
  check(stage in (
    'capture','process','ocr','normalize','ingest','cleanup',
    'capture_catalog','process_text','process_images','product_join','product_unify',
    'catalog_finalize','ingest_staging','cleanup_run'
  ));

-- v1 的"每 run 每 stage 只有一个 job"唯一约束与 Batch fan-out 冲突（一个 run 有 N 个
-- process_text）。v1 DAG 每 stage 本就只插一行，删除该约束对 v1 无损。
alter table pipeline_job drop constraint if exists pipeline_job_run_id_stage_key;

-- 分线指标（summary 的 stage 聚合）与依赖判定的常用访问路径。
create index if not exists pipeline_job_stage_state_idx on pipeline_job(stage, state);
create index if not exists pipeline_job_run_stage_idx on pipeline_job(run_id, stage);
