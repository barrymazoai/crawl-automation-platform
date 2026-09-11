import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import {
  Id,
  CreateBrand,
  UpdateBrand,
  CreateSource,
  UpdateSource,
  ToggleSource,
  ListQuery,
  SubmitCollection,
  CollectionCapabilities,
  CreateSchedule,
  UpdateSchedule,
  ExecutionIdSchema,
  ReviewListQuerySchema,
} from "@crawl-automation/v3-contracts";
import { ReviewError, type ReviewReader, type ReviewInspector } from "@crawl-automation/v3-review";
import type { BrandRepository } from "../brands/port.js";
import type { SubmissionRepository } from "../submissions/port.js";
import type { DeliveryJournal } from "../delivery/port.js";
import type { ScheduleService } from "../schedules/service.js";
import { ApiError, databaseError } from "../errors.js";
import type { DashboardReader } from "../storage/postgres-dashboard.js";

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(
      400,
      "INVALID_INPUT",
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; "),
    );
  return result.data;
}
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  if (
    c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    throw new ApiError(415, "JSON_REQUIRED", "Use application/json.");
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Malformed JSON.");
  }
  return parse(schema, raw);
}
const hash = (text: string) => createHash("sha256").update(text).digest();
export interface AppOptions {
  dashboard?: DashboardReader;
  submissions?: SubmissionRepository;
  delivery?: DeliveryJournal;
  // Kept off in normal entry points until durable delivery/reconciliation exists.
  acceptSubmissions?: boolean;
  collectionUi?: Pick<CollectionCapabilities, "environment" | "temporalUi">;
  schedules?: ScheduleService;
  reviews?: ReviewReader;
  reviewInspector?: Pick<ReviewInspector, "inspect">;
}
export function createApp(repository: BrandRepository, token: string, options: AppOptions = {}) {
  if (token.length < 32)
    throw new Error("V3 API token must contain at least 32 characters");
  const expected = hash(`Bearer ${token}`);
  const capabilities = CollectionCapabilities.parse({
    submissionIntakeEnabled: options.acceptSubmissions === true && !!options.submissions,
    environment: options.collectionUi?.environment ?? "local-v3",
    temporalUi: options.collectionUi?.temporalUi ?? [],
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (
      c.req.path !== "/healthz" &&
      !timingSafeEqual(expected, hash(c.req.header("authorization") ?? ""))
    )
      throw new ApiError(401, "UNAUTHORIZED", "Valid Bearer token required.");
    await next();
  });
  app.use(
    "/api/v3/*",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: () => {
        throw new ApiError(
          413,
          "BODY_TOO_LARGE",
          "Request body exceeds 16 KiB.",
        );
      },
    }),
  );
  app.get("/healthz", (c) =>
    c.json({ status: "ok", mode: "local-v3", collectionEnabled: false,
      submissionIntakeEnabled: options.acceptSubmissions === true && !!options.submissions }),
  );
  app.get("/api/v3/summary", async (c) => c.json(await repository.summary()));
  const dashboard = () => {
    if (!options.dashboard) throw new ApiError(503, "DASHBOARD_DISABLED", "Business dashboard is not configured");
    return options.dashboard;
  };
  app.get("/api/v3/dashboard", async c => c.json(await dashboard().summary()));
  app.get("/api/v3/dashboard/products", async c => c.json(await dashboard().products(
    c.req.query("before") ? parse(ExecutionIdSchema, c.req.query("before")) : undefined)));
  const reviews = () => {
    if (!options.reviews) throw new ApiError(503, "REVIEWS_DISABLED", "Review storage is not configured");
    return options.reviews;
  };
  app.get("/api/v3/reviews", async c => c.json(await reviews().list(parse(ReviewListQuerySchema, c.req.query()))));
  app.get("/api/v3/reviews/summary", async c => c.json(await reviews().summary()));
  app.get("/api/v3/reviews/:id", async c => {
    const item = await reviews().get(parse(ExecutionIdSchema, c.req.param("id")));
    if (!item) throw new ApiError(404, "REVIEW_NOT_FOUND", "Review record not found");
    return c.json(item);
  });
  app.get("/api/v3/reviews/:id/inspection", async c => {
    const id = parse(ExecutionIdSchema, c.req.param("id"));
    if (!options.reviewInspector) throw new ApiError(503, "REVIEW_INSPECTION_DISABLED", "Review inspection is not configured");
    return c.json(await options.reviewInspector.inspect(id, c.req.raw.signal));
  });
  app.get("/api/v3/collection-capabilities", c => c.json(capabilities));
  app.get("/api/v3/brands", async (c) =>
    c.json(await repository.list(parse(ListQuery, c.req.query()))),
  );
  app.get("/api/v3/brands/:id", async (c) =>
    c.json(await repository.get(parse(Id, c.req.param("id")))),
  );
  app.get("/api/v3/brands/:id/sources", async (c) =>
    c.json(
      await repository.listSources(
        parse(Id, c.req.param("id")),
        parse(ListQuery, c.req.query()),
      ),
    ),
  );
  const requestId = (c: Context) => parse(Id, c.req.header("Idempotency-Key"));
  app.get("/api/v3/brands/:id/sources/:sourceId/schedule", async c => {
    const brandId = parse(Id, c.req.param("id")), sourceId = parse(Id, c.req.param("sourceId"));
    return c.json({ enabled: !!options.schedules, item: options.schedules ? await options.schedules.get(brandId,sourceId) : null });
  });
  app.post("/api/v3/brands/:id/sources/:sourceId/schedule", async c => {
    if (!options.schedules) throw new ApiError(503,"SCHEDULES_DISABLED","Schedule management is disabled");
    return c.json(await options.schedules.create(parse(Id,c.req.param("id")),parse(Id,c.req.param("sourceId")),await body(c,CreateSchedule),requestId(c)),201);
  });
  app.put("/api/v3/brands/:id/sources/:sourceId/schedule", async c => {
    if (!options.schedules) throw new ApiError(503,"SCHEDULES_DISABLED","Schedule management is disabled");
    return c.json(await options.schedules.update(parse(Id,c.req.param("id")),parse(Id,c.req.param("sourceId")),await body(c,UpdateSchedule),requestId(c)));
  });
  const submissions = () => {
    if (!options.submissions)
      throw new ApiError(503, "SUBMISSIONS_UNAVAILABLE", "Submission storage is not configured.");
    return options.submissions;
  };
  app.post("/api/v3/brands/:id/sources/:sourceId/submissions", async (c) => {
    if (!options.acceptSubmissions)
      throw new ApiError(503, "SUBMISSIONS_DISABLED", "Submission intake is disabled until durable Temporal delivery is configured.");
    const result = await submissions().accept(
      parse(Id, c.req.param("id")), parse(Id, c.req.param("sourceId")),
      await body(c, SubmitCollection), requestId(c),
    );
    c.header("Idempotency-Replayed", String(result.replayed));
    c.header("Location", `/api/v3/submissions/${result.value.requestId}`);
    return c.json(result.value, 202);
  });
  app.get("/api/v3/submissions/:requestId", async (c) =>
    c.json(await submissions().get(parse(Id, c.req.param("requestId")))),
  );
  app.get("/api/v3/submissions/:requestId/delivery", async (c) => {
    const id = parse(Id, c.req.param("requestId"));
    await submissions().get(id);
    if (!options.delivery) throw new ApiError(503, "DELIVERY_UNAVAILABLE", "Delivery journal is not configured.");
    return c.json({ item: await options.delivery.get(id) });
  });
  app.get("/api/v3/brands/:id/sources/:sourceId/submissions/active", async (c) =>
    c.json({ item: await submissions().active(parse(Id, c.req.param("id")), parse(Id, c.req.param("sourceId"))) }),
  );
  app.post("/api/v3/brands", async (c) => {
    const key = requestId(c),
      input = await body(c, CreateBrand);
    const result = await repository.create(input, key);
    c.header("Idempotency-Replayed", String(result.replayed));
    return c.json(result.value, 201);
  });
  app.put("/api/v3/brands/:id", async (c) => {
    const id = parse(Id, c.req.param("id")),
      key = requestId(c),
      input = await body(c, UpdateBrand);
    const result = await repository.update(id, input, key);
    c.header("Idempotency-Replayed", String(result.replayed));
    return c.json(result.value);
  });
  app.post("/api/v3/brands/:id/sources", async (c) => {
    const id = parse(Id, c.req.param("id")),
      key = requestId(c),
      input = await body(c, CreateSource);
    const result = await repository.createSource(id, input, key);
    c.header("Idempotency-Replayed", String(result.replayed));
    return c.json(result.value, 201);
  });
  app.put("/api/v3/brands/:id/sources/:sourceId", async (c) => {
    const id = parse(Id, c.req.param("id")),
      sourceId = parse(Id, c.req.param("sourceId")),
      key = requestId(c),
      input = await body(c, UpdateSource);
    const result = await repository.updateSource(id, sourceId, input, key);
    c.header("Idempotency-Replayed", String(result.replayed));
    return c.json(result.value);
  });
  app.patch("/api/v3/brands/:id/sources/:sourceId/enabled", async (c) => {
    const id = parse(Id, c.req.param("id")),
      sourceId = parse(Id, c.req.param("sourceId")),
      key = requestId(c),
      input = await body(c, ToggleSource);
    const result = await repository.toggleSource(id, sourceId, input, key);
    c.header("Idempotency-Replayed", String(result.replayed));
    return c.json(result.value);
  });
  app.notFound((c) =>
    c.json({ error: { code: "NOT_FOUND", message: "Route not found." } }, 404),
  );
  app.onError((error, c) => {
    if (error instanceof ReviewError) return c.json({ error: { code: error.code, message: error.code } },
      error.code === "REVIEW.NOT_FOUND" ? 404 : error.code === "REVIEW.UNAVAILABLE" ? 503 : 500);
    const known = databaseError(error);
    return c.json(
      { error: { code: known.code, message: known.message } },
      known.status,
    );
  });
  return app;
}
