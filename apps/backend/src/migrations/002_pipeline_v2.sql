alter table pipeline_job drop constraint if exists pipeline_job_stage_check;
alter table pipeline_job add constraint pipeline_job_stage_check
  check(stage in ('capture','process','ocr','normalize','ingest','cleanup'));

alter table pipeline_source drop constraint if exists pipeline_source_origin_mode_key;
drop index if exists pipeline_source_origin_mode_idx;
create unique index if not exists pipeline_source_url_mode_idx on pipeline_source(url,mode);

-- 旧 stage 只为保留历史可读性；v2 调度器不再创建 ocr/normalize Job。
-- OCR 现在是 process Job 内的并发 HTTP 步骤，Amazon 也不再生成中转 Bundle。
