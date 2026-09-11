import { spawn } from "node:child_process";
import { PdfCodeSchema } from "@crawl-automation/v3-contracts";
import { PdfError } from "./errors.js";

/** Deployment-owned command only. Task payloads cannot supply executables or arguments. */
export async function runProcess(options: {
  executable: string; args: string[]; cwd: string; stdin: string;
  timeoutMs: number; signal: AbortSignal;
}): Promise<void> {
  if (options.signal.aborted) throw new PdfError("PDF.CANCELLED");
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG"])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn(options.executable, options.args, { cwd: options.cwd, env,
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let failure: PdfError | undefined, stdout = Buffer.alloc(0), stderrSize = 0;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: PdfError) => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const cancel = () => stop(new PdfError("PDF.CANCELLED"));
    const timer = setTimeout(() => stop(new PdfError("PDF.TIMEOUT")), options.timeoutMs);
    options.signal.addEventListener("abort", cancel, { once: true });
    if (options.signal.aborted) cancel();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length + chunk.length > 65536) stop(new PdfError("PDF.PROTOCOL"));
      else stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 65536) stop(new PdfError("PDF.PROTOCOL"));
      // Native logs can contain document data. Drain, but do not log or retain them.
    });
    child.on("error", () => { failure ??= new PdfError("PDF.PROCESS_FAILED"); });
    child.stdin.on("error", () => { /* close/exit determines the outcome, including EPIPE */ });
    child.stdin.end(options.stdin);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      options.signal.removeEventListener("abort", cancel);
      if (failure) return reject(failure);
      if (signal) return reject(new PdfError(signal === "SIGXCPU" || signal === "SIGXFSZ" ? "PDF.RESOURCE_LIMIT" : "PDF.PROCESS_FAILED"));
      try {
        const reply: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
        if (!reply || typeof reply !== "object") throw Error();
        const r = reply as Record<string, unknown>;
        if (code === 0 && r.protocolVersion === 1 && r.status === "completed" && Object.keys(r).length === 2) return resolve();
        if (code === 2 && r.protocolVersion === 1 && r.status === "failed" && Object.keys(r).length === 3) {
          const parsed = PdfCodeSchema.safeParse(r.code);
          if (parsed.success) return reject(new PdfError(parsed.data));
        }
      } catch { /* untrusted subprocess protocol */ }
      reject(new PdfError(code === 0 || code === 2 ? "PDF.PROTOCOL" : "PDF.PROCESS_FAILED"));
    });
  });
}
