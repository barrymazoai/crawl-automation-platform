import dns from "node:dns/promises";

/**
 * 宿主机上真实 Chrome 的 CDP 客户端（裸协议，不用 Playwright/Puppeteer）。
 *
 * 为什么必须走浏览器：同一个住宅 IP 上，商品页 `/dp/` 用 Node fetch 能拿到
 * 200，**搜索页 `/s` 一律 503** —— 补齐 sec-ch-ua / Sec-Fetch-* 头没用，先取
 * 首页 cookie 也没用（首页返回 202 且不给 cookie）。真实 Chrome 则正常返回
 * 48 条结果。差别在 TLS 指纹，不是 header 能补的。
 *
 * 为什么不打进镜像：mini 上本来就装了 Chrome，容器连过去即可，省掉约 1.3GB
 * 的 Playwright 依赖，而且持久 profile 能累积会话，更像真人。
 */

const DEFAULT_HOST = "host.docker.internal";
const DEFAULT_PORT = 9222;

/** 页面加载后再等一下让 SPA 补渲染；搜索页是服务端渲染，很快。 */
const SETTLE_MS = 1_500;
const NAV_TIMEOUT_MS = 30_000;

export class BrowserUnavailableError extends Error {
	constructor(message: string) {
		super(`chrome cdp unavailable: ${message}`);
		this.name = "BrowserUnavailableError";
	}
}
/**
 * ⚠️ 必须用 IP 而不是主机名访问 CDP。
 *
 * Chrome 会校验 Host 头防 DNS rebinding：请求 `host.docker.internal:9222`
 * 会被拒，返回的是 "Host header..." 纯文本而不是 JSON。解析成 IP 再请求就正常。
 */
async function resolveCdpBase(): Promise<string> {
	const explicit = process.env.CHROME_CDP_URL;
	if (explicit) return explicit.replace(/\/$/, "");

	const host = process.env.CHROME_CDP_HOST ?? DEFAULT_HOST;
	const port = process.env.CHROME_CDP_PORT ?? String(DEFAULT_PORT);
	// 已经是 IP 就不用解析
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return `http://${host}:${port}`;
	try {
		const { address } = await dns.lookup(host, { family: 4 });
		return `http://${address}:${port}`;
	} catch (err) {
		throw new BrowserUnavailableError(
			`cannot resolve ${host}: ${err instanceof Error ? err.message : err}`,
		);
	}
}

interface CdpTarget {
	id: string;
	type: string;
	webSocketDebuggerUrl: string;
}

async function cdpJson<T>(
	base: string,
	path: string,
	method: "GET" | "PUT" = "GET",
): Promise<T> {
	const res = await fetch(`${base}${path}`, {
		method,
		signal: AbortSignal.timeout(10_000),
	});
	const text = await res.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		// Host 头被拒时返回的就是纯文本，把它原样抛出来，比 JSON 解析错误好懂
		throw new BrowserUnavailableError(text.slice(0, 120));
	}
}

/** 一个受控的标签页；用完必须 close，否则几千个品牌跑下来会把内存堆爆。 */
export interface Page {
	/** 返回主文档的 HTTP 状态码；拿不到时为 0（判定要用它区分 404 / 503）。 */
	navigate(url: string): Promise<number>;
	evaluate<T>(expression: string): Promise<T>;
}

export async function checkBrowserAvailable(): Promise<string> {
	const base = await resolveCdpBase();
	const v = await cdpJson<{ Browser: string }>(base, "/json/version");
	return v.Browser;
}

/**
 * 开标签页跑 fn，失败就换一个新标签页再试一次。
 *
 * 为什么：浏览器操作会偶发失败（navigate 超时、websocket 断开），而这些任务
 * 一跑就是几百上千个页面。**单次故障不该毁掉整轮** —— 2026-08-11 下架检查
 * 在 147/4423 死过一次，2026-08-12 上新扫描又在 346/1296 因为
 * `websocket error` 死了一次，两次都是同一类问题。
 *
 * 每次重试都用**全新的标签页**：故障往往就是那个标签页/连接坏了，在原地重试
 * 没有意义。
 */
export async function withPageRetry<T>(
	fn: (page: Page) => Promise<T>,
	attempts = 2,
): Promise<T> {
	let lastError: unknown;
	for (let i = 0; i < attempts; i++) {
		try {
			return await withPage(fn);
		} catch (err) {
			lastError = err;
			if (i < attempts - 1) {
				console.error(
					`[browser] 第 ${i + 1} 次失败，换标签页重试:`,
					err instanceof Error ? err.message : err,
				);
				// 给 Chrome 一点喘息时间再开新标签页
				await new Promise((r) => setTimeout(r, 2_000));
			}
		}
	}
	throw lastError;
}

/** 可自行关闭的标签页会话 —— 长时间运行的任务需要能在故障后重建它。 */
export interface PageSession extends Page {
	close(): Promise<void>;
}

/**
 * 开一个标签页并把控制权交给调用方；**用完必须 close()**。
 *
 * 存在的理由：全量要跑 4,423 页、十来个小时，中途难免有一次 navigate 超时或
 * 标签页崩掉。withPage 那种「跑完就关」的形状没法在故障后重建，一次超时就会
 * 毁掉整轮（2026-08-11 实测：跑到 147 条时 Page.navigate 超时，整轮 failed）。
 */
export async function openPage(): Promise<PageSession> {
	let release: () => void = () => {};
	const closed = new Promise<void>((resolve) => {
		release = resolve;
	});
	let ready: (p: Page) => void;
	let fail: (e: unknown) => void;
	const pagePromise = new Promise<Page>((resolve, reject) => {
		ready = resolve;
		fail = reject;
	});

	// 复用 withPage 的生命周期管理：它负责建/关，我们只是把 page 借出来，
	// 直到调用方 close() 才让它收尾。
	void withPage(async (page) => {
		ready(page);
		await closed;
	}).catch((err) => fail(err));

	const page = await pagePromise;
	return {
		navigate: (url) => page.navigate(url),
		evaluate: (expr) => page.evaluate(expr),
		async close() {
			release();
		},
	};
}

/**
 * 一个会自愈的标签页：持有一个 PageSession，某次操作失败就换新标签页重来。
 *
 * 和 withPageRetry 的区别是**重试粒度**。withPageRetry 包住整个任务函数，
 * 一次 navigate 超时会让**整个任务**从头再跑一遍；holder 只重试失败的那一次
 * 操作，已经跑完的部分不受影响。几百上千个页面的长任务该用这个。
 *
 * 并发跑多标签页时每个 worker 各持一个 —— 一个坏了不影响其它 worker。
 */
export function createPageHolder(attempts = 2) {
	let session: PageSession | null = null;

	async function discard(): Promise<void> {
		const dead = session;
		session = null;
		if (dead) {
			try {
				await dead.close();
			} catch {
				// 关不掉也只能算了，别把原始错误盖掉
			}
		}
	}

	return {
		async run<T>(fn: (page: Page) => Promise<T>): Promise<T> {
			let lastError: unknown;
			for (let i = 0; i < attempts; i++) {
				try {
					if (!session) session = await openPage();
					return await fn(session);
				} catch (err) {
					lastError = err;
					await discard();
					if (i < attempts - 1) {
						console.error(
							`[browser] 操作失败，换标签页重试:`,
							err instanceof Error ? err.message : err,
						);
						await new Promise((r) => setTimeout(r, 2_000));
					}
				}
			}
			throw lastError;
		},
		close: discard,
	};
}

export type PageHolder = ReturnType<typeof createPageHolder>;

/**
 * 开一个标签页跑 fn，结束后**一定**关掉（成功失败都关）。
 */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
	const base = await resolveCdpBase();
	// ⚠️ 新版 Chrome（实测 151）只接受 PUT 开新标签页，GET 会被拒：
	// "Using unsafe HTTP verb GET to invoke /json/new"
	const target = await cdpJson<CdpTarget>(base, "/json/new?about:blank", "PUT");
	if (!target?.webSocketDebuggerUrl) {
		throw new BrowserUnavailableError("cdp did not return a page target");
	}

	const ws = new WebSocket(target.webSocketDebuggerUrl);
	let nextId = 0;
	const pending = new Map<number, (v: unknown) => void>();
	const events = new Map<string, () => void>();

	const send = (method: string, params: Record<string, unknown> = {}) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const id = ++nextId;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new BrowserUnavailableError(`${method} timed out`));
			}, NAV_TIMEOUT_MS);
			pending.set(id, (v) => {
				clearTimeout(timer);
				resolve(v as Record<string, unknown>);
			});
			ws.send(JSON.stringify({ id, method, params }));
		});

	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new BrowserUnavailableError("websocket open timed out")),
				15_000,
			);
			ws.addEventListener("open", () => {
				clearTimeout(timer);
				resolve();
			});
			ws.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new BrowserUnavailableError("websocket error"));
			});
		});

		// 主文档的响应状态；每次 navigate 前清零。
		let documentStatus = 0;
		ws.addEventListener("message", (e) => {
			const msg = JSON.parse(String(e.data));
			if (msg.id && pending.has(msg.id)) {
				pending.get(msg.id)?.(msg.result);
				pending.delete(msg.id);
				return;
			}
			if (msg.method === "Network.responseReceived") {
				// 只认主文档，忽略图片 / XHR 之类的子资源
				if (msg.params?.type === "Document") {
					documentStatus = msg.params?.response?.status ?? 0;
				}
			}
			if (msg.method && events.has(msg.method)) {
				events.get(msg.method)?.();
			}
		});

		await send("Page.enable");
		// 判定依赖状态码（404/410 → 下架，503/429 → 判不出），而 CDP 只有
		// 开了 Network 域才拿得到；Runtime.evaluate 看不见 HTTP 状态。
		await send("Network.enable");

		const page: Page = {
			async navigate(url) {
				documentStatus = 0;
				// 等真实的 load 事件，而不是拍脑袋 sleep —— 固定等待既慢又偶发抓空。
				const loaded = new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, NAV_TIMEOUT_MS);
					events.set("Page.loadEventFired", () => {
						clearTimeout(timer);
						events.delete("Page.loadEventFired");
						resolve();
					});
				});
				await send("Page.navigate", { url });
				await loaded;
				await new Promise((r) => setTimeout(r, SETTLE_MS));
				return documentStatus;
			},
			async evaluate<T>(expression: string) {
				const res = await send("Runtime.evaluate", {
					expression,
					returnByValue: true,
					awaitPromise: true,
				});
				const result = res.result as { value?: unknown } | undefined;
				return result?.value as T;
			},
		};

		return await fn(page);
	} finally {
		try {
			ws.close();
		} catch {
			// 忽略
		}
		// 标签页必须回收，失败也不能影响主流程
		try {
			await fetch(`${base}/json/close/${target.id}`, {
				signal: AbortSignal.timeout(5_000),
			});
		} catch {
			// 忽略
		}
	}
}
