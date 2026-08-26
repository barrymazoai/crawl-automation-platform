import type { Hono } from "hono";
import { z } from "zod";
import { NodeCapabilitySchema } from "@crawl-automation/contracts";
import type { PipelineRepository } from "./repository";
import type { ObjectStorage } from "./object-storage";

const bearer = (value: string | undefined) => value?.match(/^Bearer\s+(.+)$/i)?.[1];

export function mountNodeApi(app: Hono, options: { repository: PipelineRepository; storage: ObjectStorage | null; nodeTokens: Map<string, readonly string[]> }) {
  const authenticate = (authorization: string | undefined) => {
    const token = bearer(authorization); const capabilities = token ? options.nodeTokens.get(token) : undefined;
    if (!capabilities) throw new Error("unauthorized");
    return capabilities;
  };
  const body = async <T>(c: any, schema: z.ZodType<T>) => schema.parse(await c.req.json());

  app.post("/v1/node/register", async (c) => {
    const allowed = authenticate(c.req.header("authorization"));
    const input = await body(c, z.object({ nodeId: z.string().min(3), name: z.string().min(1), platform: z.string().min(1), version: z.string().min(1), capabilities: z.array(NodeCapabilitySchema), maxConcurrency: z.number().int().min(1).max(16) }));
    return c.json(await options.repository.registerNode(input, [...allowed]));
  });
  app.post("/v1/node/heartbeat", async (c) => {
    authenticate(c.req.header("authorization"));
    const input = await body(c, z.object({ nodeId: z.string().min(3), activeJobIds: z.array(z.uuid()).max(16) }));
    return c.json(await options.repository.heartbeatNode(input.nodeId, input.activeJobIds));
  });
  app.post("/v1/node/jobs/claim", async (c) => {
    const allowed = authenticate(c.req.header("authorization"));
    const input = await body(c, z.object({ nodeId: z.string().min(3), capabilities: z.array(NodeCapabilitySchema).min(1) }));
    if (input.capabilities.some((value) => !allowed.includes(value))) return c.json({ error: { code: "capability_forbidden", message: "Token 不允许该 capability" } }, 403);
    const claim = await options.repository.claim(input.nodeId, input.capabilities);
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
