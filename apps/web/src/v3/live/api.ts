import { z } from "zod";
import {
  Brand,
  Source,
  ApiErrorResponse,
} from "@crawl-automation/v3-contracts";
export class ApiFailure extends Error {
  constructor(
    public code: string,
    public uncertain: boolean,
    message: string,
  ) {
    super(message);
  }
}
const messages: Record<string, string> = {
  REVISION_CONFLICT:
    "记录已被其他页面修改。请刷新列表，再打开编辑；本次没有覆盖新版本。",
  DUPLICATE: "同名品牌或相同来源已存在，请检查列表。",
  INVALID_INPUT:
    "输入不符合规则：品牌名称最多 80 字，地区为两位字母，来源须为无账号密码的 HTTP(S) 链接。",
  UNAUTHORIZED: "API 认证失败，请检查本地服务配置。",
  BRAND_NOT_FOUND: "品牌不存在，请刷新列表。",
  SOURCE_NOT_FOUND: "来源不存在，请刷新列表。",
  SOURCE_BUSY: "来源已有未收口请求。本次未受理，请查看来源占用。",
  SOURCE_DISABLED: "来源已关闭，本次未受理。请先启用来源。",
  SUBMISSIONS_DISABLED: "此环境尚未开放采集提交。原请求编号已保留。",
  SUBMISSION_NOT_FOUND: "暂未查到该请求，不能据此认定之前的提交失败。原编号已保留。",
  SCHEDULE_CONFLICT: "计划已被修改，或与部署定义不一致。本次没有确认覆盖，请读取实际计划。",
  SCHEDULES_DISABLED: "当前环境未开放定时计划。",
};
export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
  expectedStatus?: number,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v3${path}`, {
      ...init,
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      headers: { "X-V3-Client": "local-workspace", ...init?.headers },
    });
  } catch {
    throw new ApiFailure(
      "NETWORK",
      true,
      "连接中断或超时。保存结果尚未确认，请确认原请求，不要重复新建。",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiFailure(
      "INVALID_RESPONSE",
      true,
      "服务响应不完整，结果尚未确认。",
    );
  }
  if (!response.ok) {
    const error = ApiErrorResponse.safeParse(body);
    const code = error.success ? error.data.error.code : "HTTP_ERROR";
    throw new ApiFailure(
      code,
      !error.success ||
        response.status >= 500 ||
        ["RECEIPT_INCOMPLETE", "REQUEST_ID_CONFLICT"].includes(code),
      messages[code] ?? `请求未完成（${code}）。请检查本地服务。`,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success || (expectedStatus !== undefined && response.status !== expectedStatus))
    throw new ApiFailure(
      "INVALID_RESPONSE",
      true,
      "服务响应格式异常，结果尚未确认。",
    );
  return parsed.data;
}

// One frozen mutation per tab, durably written BEFORE sending. Reloads can
// confirm exactly the same request. Neither API tokens nor demo data are stored.
const PendingSchema = z.object({
  key: z.uuid(),
  path: z
    .string()
    .regex(
      /^\/brands(?:\/[a-f0-9-]+(?:\/sources(?:\/[a-f0-9-]+(?:\/enabled)?)?)?)?$/,
    ),
  method: z.enum(["POST", "PUT", "PATCH"]),
  body: z.string(),
  label: z.string(),
  kind: z.enum(["brand", "source"]),
});
export type Pending = z.infer<typeof PendingSchema>;
export const pendingStorageKey = "crawler-v3-live:pending:v1";
export function readPending(storage: Storage): Pending | null {
  const raw = storage.getItem(pendingStorageKey);
  return raw === null ? null : PendingSchema.parse(JSON.parse(raw));
}
export function makePending(
  path: string,
  method: Pending["method"],
  body: unknown,
  label: string,
  kind: Pending["kind"],
): Pending {
  return PendingSchema.parse({
    key: crypto.randomUUID(),
    path,
    method,
    body: JSON.stringify(body),
    label,
    kind,
  });
}
export function sendPending(pending: Pending) {
  const schema: z.ZodType<Brand | Source> =
    pending.kind === "brand" ? Brand : Source;
  return request(pending.path, schema, {
    method: pending.method,
    body: pending.body,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": pending.key,
    },
  });
}
