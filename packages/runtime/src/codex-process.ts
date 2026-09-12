import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { CodexRunInput, CodexRunner } from "./codex-runner";
import { ApiError } from "./api-error";

export function codexExecutionPolicyArgs(unattendedFullAccess = false) {
  return unattendedFullAccess
    ? ["--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"]
    : ["--skip-git-repo-check", "--approve-for-me"];
}

export class CodexProcessRunner implements CodexRunner {
  /**
   * serviceTier：Codex 的服务档位。"fast" 会映射成请求里的 priority（Fast mode）。
   * 只在显式给了值时才传 -c service_tier=…；不传则沿用 Codex 自己的默认档。
   * 09-04 实测（codex-cli 0.147）：gpt-5.6-luna 接受 "fast"，不支持的档位会被 Codex 拒绝并从请求里省略。
   */
  constructor(private options: { executable?: string; model?: string; reasoningEffort?: string; serviceTier?: string; unattendedFullAccess?: boolean; persistSession?: boolean; processDiagnostics?: boolean; env?: NodeJS.ProcessEnv; inheritEnv?: boolean; configOverrides?: string[] } = {}) {}
  /** 纯函数：拼 codex exec 的参数，方便测试（spawn 不好 mock）。 */
  static buildArgs(options: { model?: string; reasoningEffort?: string; serviceTier?: string; unattendedFullAccess?: boolean; persistSession?: boolean }, input: Pick<CodexRunInput, "cwd" | "schemaPath" | "outputPath" | "addDirectories" | "imagePaths" | "persistSession">) {
    const args = ["exec", ...(options.persistSession || input.persistSession ? [] : ["--ephemeral"]), "-", "--model", options.model ?? "gpt-5.6-luna", "-c", `model_reasoning_effort=${JSON.stringify(options.reasoningEffort ?? "medium")}`,
      ...(options.serviceTier ? ["-c", `service_tier=${JSON.stringify(options.serviceTier)}`] : []),
      "--cd", input.cwd, "--output-schema", input.schemaPath, "--output-last-message", input.outputPath, "--json", "--color", "never"];
    for (const directory of input.addDirectories ?? []) args.push("--add-dir", directory);
    if (input.imagePaths?.length) args.push("--image", ...input.imagePaths);
    args.push(...codexExecutionPolicyArgs(options.unattendedFullAccess));
    return args;
  }
  async run(input: CodexRunInput) {
    await fsp.mkdir(path.dirname(input.outputPath), { recursive: true });
    input.signal?.throwIfAborted();
    const args = CodexProcessRunner.buildArgs(this.options, input);
    for (const value of this.options.configOverrides ?? []) args.push("-c", value);
    const log = fs.createWriteStream(input.eventLogPath, { flags: "a" });
    const separate = this.options.processDiagnostics ? ['stdout','stderr'].map(name => fs.createWriteStream(`${input.eventLogPath}.${name}`, {flags:'a'})) : [];
    // Diagnostics are best effort; a disk logging failure must not leave a child orphaned.
    for (const stream of [log,...separate]) stream.on('error', () => {});
    const child = spawn(this.options.executable ?? "codex", args, { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32", env: this.options.inheritEnv === false ? this.options.env : { ...process.env, ...this.options.env } });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false }); child.stdin.end(input.prompt);
    if(separate[0])child.stdout.pipe(separate[0],{end:false});if(separate[1])child.stderr.pipe(separate[1],{end:false});
    const startedAt=new Date().toISOString();let closeRecord:unknown=null;
    let stopTimer: NodeJS.Timeout | undefined;
    const abort = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        // Exact spawned process tree, never Chrome or other Workers.
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => {});
      } else {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
        stopTimer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* close is the proof */ } }, 1000);
      }
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code,signal)=>{closeRecord={pid:child.pid,startedAt,closedAt:new Date().toISOString(),exitCode:code,signal,aborted:input.signal?.aborted??false};resolve(code);});
      if (input.signal?.aborted) abort();
    }).finally(async () => {
      input.signal?.removeEventListener("abort", abort);
      if (stopTimer) clearTimeout(stopTimer);
      await Promise.all([log,...separate].map(stream=>stream.destroyed?Promise.resolve():new Promise<void>(resolve=>{stream.once('error',()=>resolve());stream.end(resolve);})));
      if(this.options.processDiagnostics)await fsp.writeFile(`${input.eventLogPath}.process.json`,JSON.stringify({version:'codex-process/1',close:closeRecord}),{flag:'wx',mode:0o600}).catch(()=>{});
    });
    if (input.signal?.aborted) throw new ApiError("codex_aborted", "Codex 任务被终止");
    if (code !== 0) throw new ApiError("codex_failed", `Codex 退出码 ${code}`);
    try { return JSON.parse(await fsp.readFile(input.outputPath, "utf8")); }
    catch { throw new ApiError("codex_output_invalid", "Codex 未生成合法结构化输出"); }
  }
}
