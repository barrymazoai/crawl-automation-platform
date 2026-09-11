// One Codex turn only. A textual confirmation ask MUST return pending.
// Human replies may be delivered separately after authenticated, single-use approval.
import {spawn} from "node:child_process";
import {open} from "node:fs/promises";

const ASK = [
  /请(?:你|您)?(?:现在)?确认/,
  /需要(?:你|您)确认/,
  /需要(?:你|您)[^\n。！？]{0,30}确认/,
  /即时确认/,
  /行动时确认/,
  /等待(?:你|您)?确认/,
  /请回复[:：]?/,
  /是否(?:允许|确认|继续)/,
  /please confirm/i,
  /confirmation required/i,
  /confirm (?:this|before|to proceed|that)/i,
  /action[- ]time/i,
  /always confirm/i,
  /waiting for (?:your )?confirm/i,
  /i need (?:you to |your )?confirm/i,
];

export function isActionTimeConfirmation(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  return ASK.some(pattern => pattern.test(text));
}

export function threadIdFromEvent(event) {
  if (!event || typeof event !== "object") return undefined;
  if (event.type === "thread.started") return event.thread_id || event.thread?.id;
  return event.thread_id || event.thread?.id;
}

export function agentMessageFromEvent(event) {
  if (event?.type !== "item.completed") return undefined;
  const item = event.item;
  if (item?.type === "agent_message" && typeof item.text === "string") return item.text;
  if (item?.type === "AgentMessage") {
    const text = item.content?.map(part => part.text || part.Text || "").join("") ?? item.text;
    return typeof text === "string" && text ? text : undefined;
  }
}

export function toolCallFromEvent(event) {
  if (event?.type !== "item.completed") return undefined;
  const item = event.item;
  if (item?.type !== "mcp_tool_call") return undefined;
  return {server: item.server, tool: item.tool, status: item.status,
    initializesChrome: item.server === 'cua_repl' && item.tool === 'js' && typeof item.arguments?.code === 'string'
      && /^\s*(?:(?:var|let|const)\s+\w+\s*=\s*)?await\s+cua\.getApp\(["']com\.google\.Chrome["']\)\s*;?\s*$/.test(item.arguments.code)};
}

export function elicitationCancelled(event, line) {
  const type = event?.type || "";
  const itemType = event?.item?.type || "";
  if (/elicit/i.test(type) || /elicit/i.test(itemType)) return true;
  return typeof line === "string" && /auto-cancelling \(not supported in exec mode\)/i.test(line);
}

function consumeJsonl(chunk, pending, onEvent) {
  pending.value += chunk.toString();
  for (let index; (index = pending.value.indexOf("\n")) >= 0;) {
    const line = pending.value.slice(0, index);
    pending.value = pending.value.slice(index + 1);
    if (!line.trim()) continue;
    try { onEvent(JSON.parse(line), line); } catch { onEvent(undefined, line); }
  }
}

function killTree(pid, signal, detached) {
  if (!Number.isInteger(pid)) return;
  try { process.kill(detached ? -pid : pid, signal); } catch {}
}

async function runOnce({executable, args, log, err, spawnFn, detached, timeoutMs, onEvent}) {
  const stderr = err && typeof err === "object" && Number.isInteger(err.fd) ? err.fd : err;
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('APPROVAL_')));
  const child = spawnFn(executable, args, {detached, env: childEnv, stdio: ["ignore", "pipe", stderr]});
  child.stderr?.resume();
  const pending = {value: ""};
  let timedOut = false;
  const terminate = () => killTree(child.pid, "SIGTERM", detached);
  const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
  const force = setTimeout(() => killTree(child.pid, "SIGKILL", detached), timeoutMs + 10_000);
  child.stdout.on("data", chunk => {
    log?.write(chunk).catch(() => terminate());
    consumeJsonl(chunk, pending, onEvent);
  });
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({code, signal}));
    });
    return {pid: child.pid, timedOut, ...result};
  } finally {
    clearTimeout(timer);
    clearTimeout(force);
  }
}

export async function runCodexWithActionConfirm(options) {
  const executable = options.executable ?? "/opt/homebrew/bin/codex";
  const prefixArgs = options.prefixArgs ?? ["-a", "never", "-s", "read-only"];
  const execArgs = options.execArgs ?? ["--skip-git-repo-check", "--json"];
  const timeoutMs = options.timeoutMs ?? 180_000;
  const spawnFn = options.spawnFn ?? spawn;
  const detached = options.detached ?? true;
  if (options.confirmReply !== undefined) throw new Error('AUTOMATIC_CONFIRM_REPLY_DISABLED');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("TIMEOUT_INVALID");
  if (typeof options.prompt !== "string" || !options.prompt.trim()) throw new Error("PROMPT_REQUIRED");
  const started = Date.now();
  const log = options.log ?? (options.logPath ? await open(options.logPath, "wx", 0o600) : undefined);
  const err = options.err ?? (options.errPath ? await open(options.errPath, "wx", 0o600) : "pipe");
  const calls = [];
  const turns = [];
  let threadId, last = "", elicitation = false, confirms = 0, timedOut = false, code = 0, signal = null, pid;
  const remaining = () => Math.max(1, timeoutMs - (Date.now() - started));
  try {
    for (let turn = 0; turn < 1; turn++) {
      const prompt = options.prompt;
      const args = options.resumeThreadId
        ? [...prefixArgs, "exec", ...execArgs, "resume", options.resumeThreadId, prompt]
        : [...prefixArgs, "exec", ...execArgs, prompt];
      threadId = options.resumeThreadId;
      last = "";
      const result = await runOnce({
        executable, args, log, err, spawnFn, detached, timeoutMs: remaining(),
        onEvent(event, line) {
          if (elicitationCancelled(event, line)) elicitation = true;
          const nextThread = threadIdFromEvent(event);
          if (nextThread) threadId = nextThread;
          const tool = toolCallFromEvent(event);
          if (tool) {
            calls.push(tool);
            options.onEvent?.({event: "LOCAL_TOOL", ...tool});
          }
          const message = agentMessageFromEvent(event);
          if (message) last = message;
        },
      });
      pid ??= result.pid;
      timedOut = result.timedOut;
      code = result.code;
      signal = result.signal;
      const asked = isActionTimeConfirmation(last);
      turns.push({turn, pid: result.pid, code, signal, timedOut, asked, last, resumed: Boolean(options.resumeThreadId)});
      if (timedOut || elicitation || code) break;
      if (!asked) break;
      break;
    }
  } finally {
    if (options.logPath) await log?.close();
    if (options.errPath && err && typeof err.close === "function") await err.close();
  }
  const asked = isActionTimeConfirmation(last);
  return {
    pid, code, signal, timedOut, threadId, confirms, calls, last, turns, elicitation,
    confirmationPending: asked,
    status: timedOut ? "TIMEOUT" : elicitation ? "ELICITATION_CANCELLED" : code !== 0 || signal ? "FAILED" : asked ? "CONFIRMATION_PENDING" : "DONE",
  };
}
