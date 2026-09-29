import { serve, type ServerType } from "@hono/node-server";
import { trpcServer } from "@hono/trpc-server";
import { Hono } from "hono";
import type { ApiContext } from "./trpc.js";
import { appRouter } from "./routers/app-router.js";

/** The HTTP app: tRPC procedures under `/trpc`, and a plain health check. No authentication. */
export function createHttpApp(context: ApiContext): Hono {
  const app = new Hono();
  app.get("/health", (request) => request.json({ ok: true }));
  app.use("/trpc/*", trpcServer({ router: appRouter, createContext: () => ({ ...context }) }));
  return app;
}

export interface ListenOptions {
  host: string;
  port: number;
}

export function listen(app: Hono, options: ListenOptions): Promise<ServerType> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, hostname: options.host, port: options.port }, () =>
      resolve(server),
    );
  });
}
