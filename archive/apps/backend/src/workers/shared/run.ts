import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobStage, NodeCapability, SalesChannelAdapter } from "@crawl-automation/contracts";
import { LocalCheckpointStore, NodeApiClient, runPool, withLeaseHeartbeat } from "@crawl-automation/runtime";

/** 控制面下发的一个任务。 */
export interface WorkerJob {
  id: string;
  runId: string;
  stage: JobStage;
  payload: any;
  source: { url: string; type: string; adapter: string | null };
  inputArtifacts: any[];
}

export interface JobContext {
  job: WorkerJob;
  leaseToken: string;
  /** 本 job 的私有工作目录（模型日志、下载的输入产物落在这里）。 */
  jobDirectory: string;
  signal: AbortSignal;
  client: NodeApiClient;
}

/** 处理结果：返回 review 表示进人工复核（旁路，不影响兄弟 job）；其余原样作为 job output 上报。 */
export type JobResult = { review: { reasonCode: string; summary: string } } | object | void;

export interface WorkerOptions {
  /** 角色名，只用于日志与默认节点名。 */
  role: string;
  /** 本进程声明的能力——写在代码里，不从环境变量拼，配不错。 */
  capabilities: NodeCapability[];
  sourceAdapters?: SalesChannelAdapter[];
  env: {
    CONTROL_PLANE_URL: string;
    MAC_NODE_TOKEN: string;
    NODE_ID: string;
    NODE_NAME: string;
    NODE_MAX_CONCURRENCY: number;
    WORK_ROOT: string;
    LOCAL_STATE_DB: string;
  };
  handle(context: JobContext): Promise<JobResult>;
  /** 心跳附带的遥测。 */
  telemetry?: () => Promise<Record<string, unknown>>;
  /** 返回 false 表示本轮不领新任务（抓取线的磁盘软阈值背压用）。 */
  canClaim?: () => Promise<boolean>;
  /** 进程退出前的清理（关浏览器、关数据库连接等）。 */
  shutdown?: () => Promise<void>;
}

/**
 * 所有 worker 入口共用的运行骨架：注册节点、心跳上报、领任务、续租约、
 * 汇报完成/失败/复核、断点记录、优雅退出。各入口只需要提供 handle()。
 */
export async function startWorker(options: WorkerOptions) {
  const { env } = options;
  const client = new NodeApiClient({ baseUrl: env.CONTROL_PLANE_URL, token: env.MAC_NODE_TOKEN, nodeId: env.NODE_ID });
  const checkpoints = new LocalCheckpointStore(env.LOCAL_STATE_DB);
  const controller = new AbortController();
  const active = new Set<string>();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());

  await client.register({
    name: env.NODE_NAME || `V2 ${options.role}`,
    platform: `${os.platform()} ${os.release()}`,
    version: "0.5.0",
    capabilities: options.capabilities,
    maxConcurrency: env.NODE_MAX_CONCURRENCY,
  });
  console.log(JSON.stringify({ type: "worker_started", role: options.role, nodeId: env.NODE_ID, capabilities: options.capabilities, concurrency: env.NODE_MAX_CONCURRENCY }));

  const heartbeat = setInterval(() => {
    const send = options.telemetry
      ? options.telemetry().then((extras) => client.heartbeat([...active], extras))
      : client.heartbeat([...active]);
    void send.catch((error) => console.error("heartbeat failed:", error instanceof Error ? error.message : error));
  }, 30_000);

  async function handleClaim(claim: any) {
    const { job, lease } = claim as { job: WorkerJob; lease: { token: string } };
    active.add(job.id);
    try {
      const jobDirectory = path.resolve(env.WORK_ROOT, job.runId, job.id);
      await fs.mkdir(jobDirectory, { recursive: true });
      checkpoints.save(job.id, job.stage, "leased", job.payload, lease.token);
      await client.start(job.id, lease.token);
      await withLeaseHeartbeat({
        client, jobId: job.id, leaseToken: lease.token, signal: controller.signal,
        onRenewError: (error, failures) => console.error(JSON.stringify({
          type: "lease_renew_failed", jobId: job.id, stage: job.stage, failures,
          message: error instanceof Error ? error.message : String(error),
        })),
      }, async (signal) => {
        const output = await options.handle({ job, leaseToken: lease.token, jobDirectory, signal, client });
        if (output && typeof output === "object" && "review" in output) {
          const review = (output as { review: { reasonCode: string; summary: string } }).review;
          await client.fail(job.id, lease.token, { code: review.reasonCode, message: review.summary, retryable: false, needsReview: true });
          checkpoints.save(job.id, job.stage, "needs_review", review, lease.token);
          return;
        }
        await client.complete(job.id, lease.token, output ?? {}, `${job.stage}:${job.id}`);
        checkpoints.save(job.id, job.stage, "completed", output ?? {}, lease.token);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ type: "job_failed", jobId: job.id, stage: job.stage, message: message.slice(0, 300) }));
      await client.fail(job.id, lease.token, { code: `${job.stage}_worker_error`, message, retryable: true })
        .catch((failError) => console.error(JSON.stringify({ type: "job_fail_report_failed", jobId: job.id, message: String(failError).slice(0, 200) })));
      checkpoints.save(job.id, job.stage, "failed", { error: message }, lease.token);
    } finally {
      active.delete(job.id);
    }
  }

  try {
    await runPool({
      concurrency: env.NODE_MAX_CONCURRENCY,
      signal: controller.signal,
      claim: async () => {
        if (options.canClaim && !await options.canClaim()) return null;
        return client.claim(options.capabilities, options.sourceAdapters);
      },
      handle: handleClaim,
      onError: console.error,
    });
  } finally {
    clearInterval(heartbeat);
    checkpoints.close();
    await options.shutdown?.().catch(() => {});
  }
}
