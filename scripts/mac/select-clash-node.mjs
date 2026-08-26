#!/usr/bin/env node
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const controller = "http://127.0.0.1:9097";
const proxy = "http://127.0.0.1:7897";
const target = "https://crawl-control-plane-v2-production.up.railway.app/healthz";
const config = "/Users/barry/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml";
const group = process.argv[2] ?? "🚀节点选择";
const maxAttempts = Number(process.argv[3] ?? 24);
const requiredSuccesses = Number(process.argv[4] ?? 3);

const yaml = await fs.readFile(config, "utf8");
const secret = yaml.match(/^secret:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };

async function api(path, init = {}) {
  const response = await fetch(`${controller}${path}`, { ...init, headers: { ...headers, ...init.headers } });
  if (!response.ok) throw new Error(`Clash API ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

async function waitForController(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await api("/version");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error("等待 Clash 控制端口恢复超时");
}

async function select(name) {
  await api(`/proxies/${encodeURIComponent(group)}`, { method: "PUT", body: JSON.stringify({ name }) });
}

async function verify() {
  const { stdout } = await run("/usr/bin/curl", [
    "-sS", "--proxy", proxy, "--connect-timeout", "4", "--max-time", "9",
    "-o", "/dev/null", "-w", "%{http_code}\t%{time_total}", target,
  ], { timeout: 11_000, maxBuffer: 1024 * 1024 });
  const [status, seconds] = stdout.trim().split("\t");
  return { status: Number(status), milliseconds: Math.round(Number(seconds) * 1000) };
}

const all = await api("/proxies");
const selectedGroup = all.proxies[group];
if (!selectedGroup || selectedGroup.type !== "Selector") throw new Error(`找不到 Selector 代理组：${group}`);
const original = selectedGroup.now;
const excludedTypes = new Set(["Selector", "URLTest", "Fallback", "LoadBalance", "Relay", "Direct", "Reject", "RejectDrop", "Pass", "PassRule", "Compatible"]);
const rawCandidates = selectedGroup.all.filter((name) => all.proxies[name] && !excludedTypes.has(all.proxies[name].type));
const candidates = rawCandidates.includes(original)
  ? [original, ...rawCandidates.filter((name) => name !== original)]
  : rawCandidates;
const successes = [];

console.log(`group=${group} original=${original} candidates=${candidates.length} maxAttempts=${maxAttempts}`);
for (const [index, name] of candidates.slice(0, maxAttempts).entries()) {
  try {
    await waitForController();
    await select(name);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const result = await verify();
    const ok = result.status === 200;
    console.log(`${index + 1}\t${ok ? "OK" : `HTTP_${result.status}`}\t${result.milliseconds}ms\t${name}`);
    if (ok) successes.push({ name, ...result });
    if (successes.length >= requiredSuccesses) break;
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.log(`${index + 1}\tFAIL\t-\t${name}\t${message}`);
  }
}

if (!successes.length) {
  await select(original);
  throw new Error(`没有找到可访问 Railway 的节点，已恢复：${original}`);
}

successes.sort((a, b) => a.milliseconds - b.milliseconds);
await waitForController();
await select(successes[0].name);
console.log(`SELECTED\t${successes[0].milliseconds}ms\t${successes[0].name}`);
