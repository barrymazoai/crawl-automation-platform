import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";

interface ControllerResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

interface ControllerRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

type ControllerFetch = (url: string, request: ControllerRequest) => Promise<ControllerResponse>;

interface ClashControllerSelectorOptions {
  baseUrl: string;
  secret: string;
  retryIntervalMs?: number;
  deadlineMs?: number;
  requestTimeoutMs?: number;
  fetch?: ControllerFetch;
}

const proxyListSchema = z.object({
  proxies: z.record(z.string(), z.object({
    all: z.array(z.string()).optional(),
    now: z.string().optional(),
  }).passthrough()),
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class ClashControllerSelector {
  private readonly baseUrl: string;
  private readonly retryIntervalMs: number;
  private readonly deadlineMs: number;
  private readonly requestTimeoutMs: number;
  private readonly agent: Agent | null;
  private readonly request: ControllerFetch;

  constructor(private readonly options: ClashControllerSelectorOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.retryIntervalMs = options.retryIntervalMs ?? 500;
    this.deadlineMs = options.deadlineMs ?? 90_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.agent = options.fetch ? null : new Agent({ connect: { timeout: 5_000 } });
    this.request = options.fetch ?? (async (url, request) => undiciFetch(url, {
      ...request,
      dispatcher: this.agent!,
    }));
  }

  async select(selector: string, proxyName: string) {
    const deadline = Date.now() + this.deadlineMs;
    let lastError = "unknown";
    do {
      try {
        await this.selectOnce(selector, proxyName);
        return;
      } catch (error) {
        lastError = errorMessage(error);
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, this.retryIntervalMs));
      }
    } while (Date.now() < deadline);
    throw new Error(`clash_selector_switch_failed:${selector}:${proxyName}:${lastError}`);
  }

  /**
   * 读出某个选择组的成员清单。
   *
   * 出口清单从这里实时取，而不是在 .env 里再抄一份——两处维护迟早不一致，
   * 而"配置里写着的出口在组里其实不存在"这种错要到运行时切换失败才暴露。
   */
  async listMembers(selector: string): Promise<string[]> {
    const list = await this.proxies();
    const group = list.proxies[selector];
    if (!group) throw new Error(`missing_selector:${selector}`);
    const members = group.all ?? [];
    if (members.length === 0) throw new Error(`empty_selector:${selector}`);
    return members;
  }

  async close() {
    await this.agent?.close();
  }

  private async selectOnce(selector: string, proxyName: string) {
    const before = await this.proxies();
    const group = before.proxies[selector];
    if (!group) throw new Error(`missing_selector:${selector}`);
    if (!group.all?.includes(proxyName)) throw new Error(`missing_proxy_in_selector:${selector}:${proxyName}`);

    const response = await this.call(`/proxies/${encodeURIComponent(selector)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: proxyName }),
    });
    if (!response.ok) throw new Error(`controller_http_${response.status}:${await response.text()}`);

    const after = await this.proxies();
    if (after.proxies[selector]?.now !== proxyName) {
      throw new Error(`selector_verification_failed:${selector}:${after.proxies[selector]?.now ?? "missing"}`);
    }
  }

  private async proxies() {
    const response = await this.call("/proxies", { method: "GET" });
    if (!response.ok) throw new Error(`controller_http_${response.status}:${await response.text()}`);
    return proxyListSchema.parse(await response.json());
  }

  private call(path: string, request: ControllerRequest) {
    return this.request(`${this.baseUrl}${path}`, {
      ...request,
      headers: {
        ...(this.options.secret ? { authorization: `Bearer ${this.options.secret}` } : {}),
        ...request.headers,
      },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
  }
}
