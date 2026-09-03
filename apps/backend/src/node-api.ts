import type { Hono } from "hono";
import { z } from "zod";
import { NodeCapabilitySchema, SalesChannelAdapterSchema } from "@crawl-automation/contracts";
import type { PipelineRepository } from "./repository";
import type { ObjectStorage } from "./object-storage";

const bearer = (value: string | undefined) => value?.match(/^Bearer\s+(.+)$/i)?.[1];

export function mountNodeApi(app: Hono, options: { repository: PipelineRepository; storage: ObjectStorage | null; nodeTokens: Map<string, readonly string[]>; keyPrefix?: string }) {
  const authenticate = (authorization: string | undefined) => {
    const token = bearer(authorization); const capabilities = token ? options.nodeTokens.get(token) : undefined;
    if (!capabilities) throw new Error("unauthorized");
    return capabilities;
  };
  const body = async <T>(c: any, schema: z.ZodType<T>) => schema.parse(await c.req.json());

  app.post("/v1/node/register", async (c) => {
    const allowed = authenticate(c.req.header("authorization"));
    const input = await body(c, z.object({ nodeId: z.string().min(3), name: z.string().min(1), platform: z.string().min(1), version: z.string().min(1), capabilities: z.array(NodeCapabilitySchema), maxConcurrency: z.number().int().min(1).max(64) }));
    return c.json(await options.repository.registerNode(input, [...allowed]));
  });
  app.post("/v1/node/heartbeat", async (c) => {
    authenticate(c.req.header("authorization"));
    const input = await body(c, z.object({
      nodeId: z.string().min(3),
      // 上限要盖过任何池的节点并发。曾经是 16：文字线提到 24 之后每次心跳都被拒（text.log 里 1,126 次），
      // 节点在面板上"离线"5 小时、磁盘/Codex 遥测全丢；租约续期走的是另一条通道所以任务没受影响。
      activeJobIds: z.array(z.uuid()).max(64),
      // worker 遥测（磁盘背压、出口轮动 IP、Codex 余量），透传存进节点 metadata。
      extras: z.record(z.string(), z.unknown()).optional(),
    }));
    return c.json(await options.repository.heartbeatNode(input.nodeId, input.activeJobIds, input.extras));
  });
  app.post("/v1/node/jobs/claim", async (c) => {
    const allowed = authenticate(c.req.header("authorization"));
    const input = await body(c, z.object({
      nodeId: z.string().min(3),
      capabilities: z.array(NodeCapabilitySchema).min(1),
      sourceAdapters: z.array(SalesChannelAdapterSchema).min(1).optional(),
    }));
    if (input.capabilities.some((value) => !allowed.includes(value))) return c.json({ error: { code: "capability_forbidden", message: "Token 不允许该 capability" } }, 403);
    const claim = await options.repository.claim(input.nodeId, input.capabilities, input.sourceAdapters);
    return claim ? c.json(claim) : c.body(null, 204);
  });
  app.post("/v1/node/jobs/:id/start", async (c) => {
    authenticate(c.req.header("authorization"));
    const input = await body(c, z.object({ leaseToken: z.string().min(20) }));
    return c.json(await options.repository.start(c.req.param("id"), input.leaseToken));
  });
  app.post("/v1/node/jobs/:id/heartbeat", async (c) => {
    authenticate(c.req.header("authorization"));
    const input = await body(c, z.object({ leaseToken: z.string().min(20) }));
    return c.json(await options.repository.renew(c.req.param("id"), input.leaseToken));
  });
  app.post("/v1/node/jobs/:id/complete", async (c) => {
    authenticate(c.req.header("authorization"));
    const input = await body(c, z.object({ leaseToken: z.string().min(20), output: z.unknown() }));
    return c.json(await options.repository.complete(c.req.param("id"), input.leaseToken, input.output, c.req.header("idempotency-key") ?? ""));
  });
  app.post("/v1/node/jobs/:id/fail", async (c) => {
    authenticate(c.req.header("authorization"));
    const input = await body(c, z.object({ leaseToken: z.string().min(20), code: z.string().min(1), message: z.string().min(1), retryable: z.boolean(), needsReview: z.boolean().optional() }));
    const { leaseToken, ...failure } = input;
    return c.json(await options.repository.fail(c.req.param("id"), leaseToken, failure, c.req.header("idempotency-key") ?? ""));
  });
  // v2：抓取 worker 每原子发布一个 Capture Batch 后调用，为该 Batch 追加处理子 DAG。
  app.post("/v1/node/jobs/:id/batches", async (c) => {
    authenticate(c.req.header("authorization"));
    const input = await body(c, z.object({
      leaseToken: z.string().min(20),
      batchId: z.string().min(1).max(128),
      ordinal: z.number().int().nonnegative(),
      itemCount: z.number().int().positive(),
      batchDirectory: z.string().min(1),
      imagesRequired: z.boolean(),
      exit: z.string().min(1).max(64).nullish(),
    }));
    const { leaseToken, ...batch } = input;
    return c.json(await options.repository.registerCaptureBatch(c.req.param("id"), leaseToken, batch), 201);
  });
  // v2：目录完全遍历后调用一次，追加 run 级尾部（catalog_finalize -> ingest_staging -> cleanup_run）。
  app.post("/v1/node/jobs/:id/finalize-catalog", async (c) => {
    authenticate(c.req.header("authorization"));
    const input = await body(c, z.object({
      leaseToken: z.string().min(20),
      inputKind: z.enum(["brand_catalog", "product", "search"]),
      exhausted: z.boolean(),
      truncated: z.boolean(),
      expectedCount: z.number().int().nonnegative().nullable(),
      discoveredCount: z.number().int().nonnegative(),
      processedCount: z.number().int().nonnegative(),
    }));
    const { leaseToken, ...catalog } = input;
    return c.json(await options.repository.finalizeCatalog(c.req.param("id"), leaseToken, catalog), 201);
  });
  app.post("/v1/node/jobs/:id/artifacts", async (c) => {
    authenticate(c.req.header("authorization"));
    if (!options.storage) return c.json({ error: { code: "storage_unavailable", message: "对象存储未配置" } }, 503);
    const input = await body(c, z.object({
      leaseToken: z.string().min(20), kind: z.enum(["evidence_bundle", "codex_raw", "normalized", "review"]),
      fileName: z.string().min(1), contentType: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().nonnegative(),
    }));
    const { leaseToken, ...metadata } = input;
    const artifact = await options.repository.createArtifact(c.req.param("id"), leaseToken, metadata, c.req.header("idempotency-key") ?? "");
    return c.json({ artifact, uploadUrl: await options.storage.uploadUrl(artifact.bucketKey, artifact.sha256, artifact.contentType) }, 201);
  });
  app.post("/v1/node/artifacts/:id/confirm", async (c) => {
    authenticate(c.req.header("authorization"));
    if (!options.storage) return c.json({ error: { code: "storage_unavailable", message: "对象存储未配置" } }, 503);
    const input = await body(c, z.object({ jobId: z.uuid(), leaseToken: z.string().min(20) }));
    const artifact = await options.repository.getArtifact(c.req.param("id"));
    await options.storage.verify(artifact.bucket_key, artifact.sha256, Number(artifact.byte_size));
    return c.json({ artifact: await options.repository.confirmArtifact(artifact.id, input.jobId, input.leaseToken) });
  });
  app.post("/v1/node/artifacts/:id/download", async (c) => {
    authenticate(c.req.header("authorization"));
    if (!options.storage) return c.json({ error: { code: "storage_unavailable", message: "对象存储未配置" } }, 503);
    const artifact = await options.repository.getArtifact(c.req.param("id"));
    if (artifact.status !== "ready") return c.json({ error: { code: "artifact_not_ready", message: "产物未就绪" } }, 409);
    return c.json({ downloadUrl: await options.storage.downloadUrl(artifact.bucket_key) });
  });
  /*
   * 站点 profile：Skill 学到的探索路线，按 host 托管在对象存储。
   * 节点开工前 GET 拉全部 ready 文件；收工后逐个 POST 登记 → PUT 上传 → confirm。
   * 任何持有节点 token 的节点都能读写——换节点零配置。
   */
  const hostParam = z.string().min(1).max(253).regex(/^[a-z0-9.-]+$/i, "host 只能是域名");
  const fileParam = z.string().min(6).max(300).regex(/^[a-z0-9._-]+\.json$/i, "文件名只能是 <host>-<hash>.json");
  app.get("/v1/node/site-profiles/:host", async (c) => {
    authenticate(c.req.header("authorization"));
    if (!options.storage) return c.json({ error: { code: "storage_unavailable", message: "未配置对象存储" } }, 503);
    const host = hostParam.parse(c.req.param("host")).toLowerCase();
    const files = await options.repository.listSiteProfiles(host);
    return c.json({ files: await Promise.all(files.map(async (file) => ({
      fileName: file.file_name, sha256: file.sha256, byteSize: Number(file.byte_size), profileVersion: file.profile_version,
      learnedBy: file.learned_by, updatedAt: file.updated_at, downloadUrl: await options.storage!.downloadUrl(file.bucket_key),
    }))) });
  });
  app.post("/v1/node/site-profiles/:host/files", async (c) => {
    authenticate(c.req.header("authorization"));
    if (!options.storage) return c.json({ error: { code: "storage_unavailable", message: "未配置对象存储" } }, 503);
    const host = hostParam.parse(c.req.param("host")).toLowerCase();
    const input = await body(c, z.object({
      nodeId: z.string().min(3), fileName: fileParam, sha256: z.string().regex(/^[0-9a-f]{64}$/), byteSize: z.number().int().positive(),
      profileVersion: z.number().int().nullable().optional(),
    }));
    const record = await options.repository.upsertSiteProfile({ host, fileName: input.fileName, sha256: input.sha256, byteSize: input.byteSize, profileVersion: input.profileVersion ?? null, learnedBy: input.nodeId }, options.keyPrefix ?? "");
    return c.json({ file: record, uploadUrl: await options.storage.uploadUrl(record.bucketKey, record.sha256, "application/json") }, 201);
  });
  app.post("/v1/node/site-profiles/:host/files/:file/confirm", async (c) => {
    authenticate(c.req.header("authorization"));
    if (!options.storage) return c.json({ error: { code: "storage_unavailable", message: "未配置对象存储" } }, 503);
    const host = hostParam.parse(c.req.param("host")).toLowerCase();
    const fileName = fileParam.parse(c.req.param("file"));
    const record = await options.repository.getSiteProfile(host, fileName);
    if (!record) return c.json({ error: { code: "not_found", message: "profile 文件未登记" } }, 404);
    await options.storage.verify(record.bucket_key, record.sha256, Number(record.byte_size));
    return c.json({ file: await options.repository.confirmSiteProfile(host, fileName) });
  });
  app.get("/v1/node/runs/:id/artifacts", async (c) => {
    authenticate(c.req.header("authorization"));
    return c.json({ artifacts: await options.repository.listRunArtifacts(c.req.param("id")) });
  });
  app.post("/v1/node/artifacts/:id/delete", async (c) => {
    authenticate(c.req.header("authorization"));
    if (!options.storage) return c.json({ error: { code: "storage_unavailable", message: "对象存储未配置" } }, 503);
    const input = await body(c, z.object({ jobId: z.uuid(), leaseToken: z.string().min(20) }));
    await options.repository.renew(input.jobId, input.leaseToken);
    const artifact = await options.repository.getArtifact(c.req.param("id"));
    try { await options.storage.delete(artifact.bucket_key); await options.repository.markArtifactDeleted(artifact.id); }
    catch (error) { await options.repository.markArtifactDeleted(artifact.id, true); throw error; }
    return c.json({ success: true });
  });
}
