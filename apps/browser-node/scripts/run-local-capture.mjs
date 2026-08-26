import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerRunner, buildBrowserCapturePrompt } from "../../../packages/runtime/dist/index.js";

function parseArgs(argv) {
  const options = { url: null, jobDirectory: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--url") options.url = argv[++index];
    else if (argument === "--job-directory") options.jobDirectory = argv[++index];
    else if (!argument.startsWith("--") && !options.url) options.url = argument;
    else throw new Error(`未知参数：${argument}`);
  }
  if (!options.url) throw new Error("用法：run-local-capture.mjs --url <site> [--job-directory <existing-or-new-directory>]");
  const url = new URL(options.url.includes("://") ? options.url : `https://${options.url}`);
  return { url: url.toString(), jobDirectory: options.jobDirectory };
}

function safeSlug(hostname) {
  return hostname.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const options = parseArgs(process.argv.slice(2));
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const site = new URL(options.url);
const defaultDirectory = path.join(repositoryRoot, ".automation-runs", "local", `${safeSlug(site.hostname)}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const jobDirectory = path.resolve(options.jobDirectory ?? defaultDirectory);
const sessionPath = path.join(jobDirectory, "session.json");
await fsp.mkdir(jobDirectory, { recursive: true });

const previous = JSON.parse(await fsp.readFile(sessionPath, "utf8").catch(() => "null"));
if (previous?.url && previous.url !== options.url) throw new Error(`任务目录属于另一个网站：${previous.url}`);
const session = previous ?? {
  url: options.url,
  runId: randomUUID(),
  jobId: randomUUID(),
  createdAt: new Date().toISOString(),
};
const persistSession = (update = {}) => {
  Object.assign(session, update, { updatedAt: new Date().toISOString() });
  fs.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
};
persistSession();

const skillPath = path.join(repositoryRoot, "crawl-products", "SKILL.md");
const publisherPath = path.join(repositoryRoot, "apps", "browser-node", "scripts", "publish-capture-batch.mjs");
const basePrompt = buildBrowserCapturePrompt({
  url: options.url,
  runId: session.runId,
  jobDirectory,
  nodeId: "local-app-server",
});
const prompt = `${basePrompt}

这是本地 App Server 真实抓取测试，当前仓库可能有未提交实现：禁止执行 git 命令、禁止修改仓库源码。显式注入的 crawl-products Skill 就是本次真源，必须完整读取。

本次口径：抓取 ${options.url} 的完整可见目录，只生成 Browser Node EvidenceBundleV1，不调用控制面、不调用 OCR、不做最终语义规范化、不调用数据库。优先探测并使用 Shopify HTTP 通道；只有 HTTP 证据不足时才尝试浏览器。

每个可售变体必须成为 EvidenceBundleV1.items 中的独立 item，externalId 优先 variantId、其次真实 SKU，variant 保存 variantId、SKU 和全部选项。基础商品没有变体时也保留真实 SKU；确实没有才写 sku=null、skuMissing=true。所有 sourceFiles/imageFiles 必须指向批次目录内真实存在的相对路径，bundle.json 的 files 清单必须与磁盘文件一致并包含 SHA256、byteSize、mediaType。

此次目录预计较小，完成后建立一个 staging 批次并执行：
node ${JSON.stringify(publisherPath)} ${JSON.stringify(jobDirectory)} 0 <item-count> <staging-directory>
把 staging 原子发布到 handoff。若 handoff/evidence-000000 已存在，先验证并复用，禁止覆盖。

最终 batches 必须逐项匹配 handoff/*.ready.json。目录耗尽、变体展开完成、图片与页面证据落盘且 Manifest 对账一致后才返回 complete；否则返回 needs_review 或 failed，并给出具体 reasonCode。`;

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
const runner = new CodexAppServerRunner({
  executable: process.env.CODEX_EXECUTABLE ?? "codex",
  model: process.env.CODEX_MODEL ?? "gpt-5.6-luna",
  reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "medium",
  unattendedFullAccess: process.env.CODEX_UNATTENDED_FULL_ACCESS === "true",
});

persistSession({ status: "running", result: null, error: null });
try {
  const result = await runner.run({
    prompt,
    cwd: jobDirectory,
    schemaPath: path.join(repositoryRoot, "apps", "browser-node", "capture-result.schema.json"),
    outputPath: path.join(jobDirectory, "capture-result.json"),
    eventLogPath: path.join(jobDirectory, "codex-events.jsonl"),
    addDirectories: [jobDirectory],
    ...(session.threadId ? { threadId: session.threadId } : {}),
    threadName: `Local crawl ${site.hostname}`,
    skill: { name: "crawl-products", path: skillPath },
    signal: controller.signal,
    onSession: ({ threadId, turnId }) => persistSession({ threadId, ...(turnId ? { turnId } : {}) }),
  });
  persistSession({ status: result.status, result, error: null });
  console.log(`result ${JSON.stringify(result)}`);
  console.log(`job-directory ${jobDirectory}`);
} catch (error) {
  persistSession({ status: "runner_failed", result: null, error: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await runner.close();
}
