import { existsSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import pg from "pg";
import pino from "pino";
import { ProxyAgent, fetch as proxyFetch } from "undici";
import { loadConfig } from "./config";
import { migrate } from "./migrate";
import { ObjectStorage } from "./object-storage";
import { PipelineRepository } from "./repository";
import { createAppRouter } from "./app-router";
import { mountNodeApi } from "./node-api";

const config = loadConfig();
const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const app = new Hono();
const controlPlaneDispatcher = config.controlPlaneProxyUrl ? new ProxyAgent(config.controlPlaneProxyUrl) : null;

app.get("/healthz", (c) => c.json({ status: "ok", mode: config.mode }));

if (config.mode === "proxy") {
  app.all("/api/rpc/*", async (c) => {
    const target = `${config.controlPlaneUrl!.replace(/\/$/, "")}${c.req.path}${new URL(c.req.url).search}`;
    const request = {
      method: c.req.method,
      headers: { "content-type": c.req.header("content-type") ?? "application/json", authorization: `Bearer ${config.adminToken}` },
      ...(["GET", "HEAD"].includes(c.req.method) ? {} : { body: await c.req.raw.arrayBuffer() }),
    };
    const response = controlPlaneDispatcher
      ? await proxyFetch(target, { ...request, dispatcher: controlPlaneDispatcher })
      : await fetch(target, request);
    return new Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: response.headers });
  });
} else {
  await migrate(config.databaseUrl!);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 12 });
  const repository = new PipelineRepository(pool, config.leaseTtlSeconds);
  const storage = config.s3 ? new ObjectStorage(config.s3) : null;
  mountNodeApi(app, { repository, storage, nodeTokens: config.nodeTokens });
  let scheduling = false;
  setInterval(() => {
    if (scheduling) return; scheduling = true;
    void repository.enqueueDueRecurring().catch((error) => logger.error({ err: error }, "recurring scheduler failed")).finally(() => { scheduling = false; });
  }, 30_000).unref();
  const rpc = new RPCHandler(createAppRouter(repository));
  app.use("/api/rpc/*", async (c) => {
    if (!config.lanUiEnabled && c.req.header("authorization") !== `Bearer ${config.adminToken}`) return c.json({ error: "unauthorized" }, 401);
    const result = await rpc.handle(c.req.raw, { prefix: "/api/rpc", context: {} });
    return result.matched ? c.newResponse(result.response.body, result.response) : c.notFound();
  });
}

const webRoot = path.resolve(process.env.WEB_DIST_DIR ?? "../web/dist");
if (existsSync(webRoot)) {
  app.use("/assets/*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ root: webRoot, path: "index.html" }));
}

app.onError((error, c) => {
  logger.error({ err: error, path: c.req.path }, "request failed");
  const status = error.message === "unauthorized" ? 401 : 400;
  return c.json({ error: { code: status === 401 ? "unauthorized" : "request_failed", message: error.message } }, status);
});

serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => logger.info({ port: info.port, mode: config.mode }, "backend listening"));
