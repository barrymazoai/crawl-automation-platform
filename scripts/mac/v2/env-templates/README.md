# v2 Pool 环境模板

方案 4：一个 Pool = 一个独立 worker 进程，各自注册 capability、各自配置并发。
把模板复制到仓库根目录并补齐通用变量后启动：

```bash
cp scripts/mac/v2/env-templates/.env.v2-text.example .env.v2-text
scripts/mac/v2/start-v2-pool.sh text
```

## 每个 Pool 都需要的通用变量（从 .env.mac-worker 复制）

```
CONTROL_PLANE_URL=
MAC_NODE_TOKEN=
PRODUCT_DATABASE_URL=
PRODUCT_SERVER_URL=
PRODUCT_SERVER_TOKEN=          # 或 PRODUCT_SERVER_API_KEY
OCR_ENDPOINT=
WORK_ROOT=                     # 所有 Pool 必须指向同一目录（同一台 Mac mini）
REVIEW_ROOT=
```

## Codex 预算静态切分（账号级限流，跨进程）

各 Pool 的 `CODEX_CONCURRENCY` 之和不要超过账号实测限流。
建议基线：text 10 + unify 2 + image 2 + capture 1 ≈ 15。

## launchd 常驻

照 `scripts/mac/com.supplysmart.crawl-worker-v2.plist` 的形状，每个 Pool 建一个 plist，
ProgramArguments 指向 `scripts/mac/v2/start-v2-pool.sh <pool>`，Label 用
`com.supplysmart.crawl-v2-<pool>`。冒烟阶段直接在终端前台跑即可。

## 磁盘背压（方案 6，只作用于抓取 Pool）

```
DISK_SOFT_MIN_FREE_GB=40   # 低于此不领新目录
DISK_HARD_MIN_FREE_GB=15   # 低于此暂停发布 Batch
```

处理/入库 Pool 不需要设置——代码只在抓取类 capability 上启用背压。

## 下架保险丝（方案 9）

`FORCE_PARTIAL_SCOPE` 默认就是 `true`：迁移期所有入库强制 partial，物理上不可能触发缺席下架。
阶段 6 验收通过前不要设为 false。
