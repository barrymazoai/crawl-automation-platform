import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

const brotli = promisify(zlib.brotliCompress);
const unbrotli = promisify(zlib.brotliDecompress);

/**
 * 把抓到的商品页 HTML 存到本地磁盘。
 *
 * 为什么值得存：**重新爬是最贵也最危险的一步**（会撞风控），解析是廉价的。
 * 存下原始页面之后，以后想加字段（价格、评分、成分、A+ 内容）直接离线重解，
 * 不用再打一次 Amazon。
 *
 * 实测（2026-08-11，B000PR3HCG）：
 * - 整页 1.79 MB，经 CDP 传回只要 109ms —— 相比每页本来就要花的 ~7 秒可忽略
 * - brotli 后 265 KB（6.9x）；4,423 条每条留最新一份约 1.1 GB
 *
 * **不剥 script**：验过 parentAsin / bylineInfo 剥掉后仍在，但价格、评分这类
 * 数据很可能就埋在 script 的 JSON 里 —— 剥了就把「以后不用重爬」这个目的
 * 破坏了一半。压缩比剥更划算。
 *
 * 定位是**中转区**：存本地 → 同步到别处 → 删本地。所以扁平目录 + ASIN 命名，
 * rsync 和清理都最省事。
 */

const DEFAULT_DIR = "/data/pages";

export interface SnapshotResult {
	path: string;
	bytes: number;
	sha256: string;
}

export function snapshotDir(override?: string): string {
	return override ?? process.env.SNAPSHOT_DIR ?? DEFAULT_DIR;
}

/** 关掉存档（本地开发常用；生产留空即开启）。 */
export function snapshotsEnabled(): boolean {
	return process.env.SNAPSHOT_DISABLED !== "1";
}

/** 文件名只允许 ASIN 那种字符，防止 URL 里的怪字符跑进路径。 */
function safeKey(key: string): string {
	return key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/**
 * 读回一份存档的整页 HTML；没有就返回 null。
 *
 * 清洗管线靠它把 1.7 MB 的原始页面重新拿出来抠字段 —— **零网络请求**。
 * 这正是当初坚持留档的价值：品牌名抠取率 35%→94%、上架日期 42%→90%，
 * 两次都是离线重跑存档修好的，一个 Amazon 请求都没多发。
 *
 * 和 saveSnapshot 一样**绝不抛异常**：读不到就是读不到，调用方按「跳过这条」
 * 处理，不该让整批清洗挂掉。
 */
export async function readSnapshot(key: string, directory?: string): Promise<string | null> {
	if (!key) return null;
	try {
		const file = path.join(snapshotDir(directory), `${safeKey(key)}.html.br`);
		const buf = await fs.readFile(file);
		return (await unbrotli(buf)).toString("utf8");
	} catch {
		return null;
	}
}

/**
 * 存一份快照，返回落盘信息；失败返回 null。
 *
 * **绝不抛异常** —— 存档是副产品，磁盘满了、目录没权限都不该让下架判定失败。
 */
export async function saveSnapshot(
	key: string,
	html: string,
	directory?: string,
): Promise<SnapshotResult | null> {
	if (!snapshotsEnabled() || !html) return null;
	try {
		const dir = snapshotDir(directory);
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, `${safeKey(key)}.html.br`);
		const buf = Buffer.from(html, "utf8");
		const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
		const compressed = await brotli(buf);
		// 先写临时文件再改名：中途挂掉不会留下半个文件被当成完整快照
		const tmp = `${file}.tmp`;
		await fs.writeFile(tmp, compressed);
		await fs.rename(tmp, file);
		return { path: file, bytes: compressed.length, sha256 };
	} catch (err) {
		console.error(`[snapshot] failed for ${key}:`, err);
		return null;
	}
}

/** 磁盘上现在存了多少 —— 页面上显示，好判断什么时候该同步走。 */
export async function snapshotUsage(): Promise<{
	files: number;
	bytes: number;
}> {
	try {
		const dir = snapshotDir();
		const names = await fs.readdir(dir);
		let bytes = 0;
		let files = 0;
		for (const name of names) {
			if (!name.endsWith(".html.br")) continue;
			const stat = await fs.stat(path.join(dir, name));
			bytes += stat.size;
			files += 1;
		}
		return { files, bytes };
	} catch {
		return { files: 0, bytes: 0 };
	}
}
