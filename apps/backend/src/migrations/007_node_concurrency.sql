-- 节点并发上限从 16 放宽到 64：文字池的批次几乎全是等模型返回，
-- 真实约束是 Codex 配额与内存，不该被建表时的魔数卡住（2026-09-03 提并发时被这条 check 拒绝注册）。
alter table pipeline_node drop constraint if exists pipeline_node_max_concurrency_check;
alter table pipeline_node add constraint pipeline_node_max_concurrency_check check (max_concurrency between 1 and 64);
