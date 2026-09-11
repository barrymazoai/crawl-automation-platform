// Explicit, isolated browser acceptance fixture. Never opens an existing database.
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { startTestDatabase } from "./postgres.js";
import { createApp } from "../src/http/app.js";
import { PostgresBrands } from "../src/storage/postgres-brands.js";
import { PostgresSubmissions } from "../src/storage/postgres-submissions.js";
import { PostgresDelivery } from "../src/storage/postgres-delivery.js";

if (process.env.V3_UI_ACCEPTANCE !== "isolated") throw new Error("Explicit isolated UI acceptance opt-in required");
const root = fileURLToPath(new URL("../../web/dist-v3-live/", import.meta.url));
await readFile(join(root, "v3-live.html")); // Require an actual production build.
const db = await startTestDatabase();
const token = randomBytes(32).toString("hex");
const api = createApp(new PostgresBrands(db.pool), token, {
  submissions: new PostgresSubmissions(db.pool), delivery: new PostgresDelivery(db.pool), acceptSubmissions: false,
});
const app = new Hono();
app.use("*", async (c, next) => {
  if (c.req.header("host") !== "127.0.0.1:4183") return c.text("Local acceptance only", 403);
  c.header("Cache-Control", "no-store"); await next();
});
app.all("/api/v3/*", async c => {
  if (c.req.header("X-V3-Client") !== "local-workspace" ||
      (c.req.header("origin") && c.req.header("origin") !== "http://127.0.0.1:4183") ||
      (c.req.method !== "GET" && c.req.header("origin") !== "http://127.0.0.1:4183")) return c.text("Local acceptance only", 403);
  const req = new Request(c.req.raw); req.headers.set("authorization", `Bearer ${token}`);
  return api.fetch(req);
});
app.get("/", c => c.redirect("/v3-live.html"));
app.use("*", serveStatic({ root }));
let server: ReturnType<typeof serve> | undefined;
try {
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 4183 });
  await new Promise<void>((resolve, reject) => { server!.once("listening", resolve); server!.once("error", reject); });
  console.log(JSON.stringify({ event: "UI_ACCEPTANCE_READY", url: "http://127.0.0.1:4183/v3-live.html", database: "crawler_v3_test", evidence: db.root, pid: process.pid }));
  await new Promise<void>(resolve => { process.once("SIGTERM", resolve); process.once("SIGINT", resolve); });
} finally {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  const proof = {
    brands: (await db.pool.query("SELECT id,name,note,revision FROM brand ORDER BY created_at")).rows,
    sources: (await db.pool.query("SELECT id,brand_id,channel,region,url,enabled,revision FROM brand_source ORDER BY created_at")).rows,
    receipts: (await db.pool.query("SELECT request_id,operation FROM api_request_receipt ORDER BY created_at")).rows,
    submissions: (await db.pool.query("SELECT count(*) FROM collection_submission")).rows[0].count,
  };
  await writeFile(join(db.root, "ui-acceptance-proof.json"), JSON.stringify(proof, null, 2), { mode: 0o600 });
  console.log("UI_ACCEPTANCE_PROOF", JSON.stringify(proof));
  await db.close();
}
