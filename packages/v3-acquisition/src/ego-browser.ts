import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { BrowserError, type RenderedBrowser, type RenderedPage } from "./browser.js";
import { permittedUrl } from "./network.js";

/** Private runtime configuration, never a Workflow payload. The coordinator owns the space. */
export const EgoBrowserConfigSchema = z.strictObject({
  engine: z.literal("ego-lite"), sdk: z.enum(["1", "2"]),
  cliPath: z.string().refine(isAbsolute), taskSpaceId: z.number().int().positive(),
  targetId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), sessionId: z.string().min(1).max(200),
});
export type EgoBrowserConfig = z.infer<typeof EgoBrowserConfigSchema>;
export interface EgoCommandRunner {
  run(cliPath: string, script: string, signal: AbortSignal): Promise<unknown>;
}
const marker = "CRAWLV3_EGO_SNAPSHOT:";
const MAX_OUTPUT = 8 * 1024 * 1024;
const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

/** CLI stdin is an explicit heredoc, no persisted executable browser scripts or direct CDP socket. */
export class EgoCliRunner implements EgoCommandRunner {
  async run(cliPath: string, script: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    // Keep large HTML out of CLI logs. The transport owns this private artifact path;
    // SDK1 writes cliLog receipts to stderr, while SDK2 may use stdout.
    const folder = await mkdtemp(join(tmpdir(), "crawlv3-ego-snapshot-"));
    const output = join(folder, "snapshot.json");
    const publish = `
const fs=await import('node:fs/promises');const crypto=await import('node:crypto');
const bytes=Buffer.from(JSON.stringify(snapshot));
if(bytes.length>8388608)throw Error('EGO_SNAPSHOT_LIMIT');
await fs.writeFile(${JSON.stringify(output)},bytes,{mode:0o600,flag:'wx'});
const receipt=JSON.stringify({bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
if(typeof cliLog==='function')cliLog(${JSON.stringify(marker)}+receipt);else console.log(${JSON.stringify(marker)}+receipt);`;
    const rawReceipt = await new Promise<unknown>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", `${shellQuote(cliPath)} nodejs <<'CRAWLV3_EGO_EOF'\n${script}\n${publish}\nCRAWLV3_EGO_EOF`],
        { stdio: ["ignore", "pipe", "pipe"], detached: true });
      let out = "", err = "", bytes = 0, failure: unknown;
      const stop = (reason: unknown) => {
        failure ??= reason;
        // Stop only this CLI process group; never close the user's browser or space.
        if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { /* exited */ }
      };
      const cancel = () => stop(signal.reason);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (b: string) => {
        bytes += Buffer.byteLength(b);
        if (bytes > MAX_OUTPUT) return stop(new BrowserError("SOURCE.BROWSER_SNAPSHOT_INVALID"));
        out += b;
      });
      child.stderr.on("data", (b: string) => {
        bytes += Buffer.byteLength(b);
        if (bytes > MAX_OUTPUT) return stop(new BrowserError("SOURCE.BROWSER_PROTOCOL"));
        err += b;
      });
      child.on("error", () => { failure ??= new BrowserError("SOURCE.BROWSER_UNAVAILABLE"); });
      child.on("close", code => {
        signal.removeEventListener("abort", cancel);
        if (failure) return reject(failure);
        if (code !== 0) return reject(new BrowserError(
          /user is controlling|inactive|not assigned to an agent|user-owned/i.test(err + out)
            ? "SOURCE.BROWSER_USER_CONTROL" : "SOURCE.BROWSER_UNAVAILABLE"));
        const lines = (out + "\n" + err).split(/\r?\n/).filter(line => line.startsWith(marker));
        if (lines.length !== 1) return reject(new BrowserError("SOURCE.BROWSER_PROTOCOL"));
        try { resolve(JSON.parse(lines[0]!.slice(marker.length))); }
        catch { reject(new BrowserError("SOURCE.BROWSER_PROTOCOL")); }
      });
    });
    signal.throwIfAborted();
    const receipt = z.strictObject({bytes:z.number().int().positive().max(MAX_OUTPUT),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).safeParse(rawReceipt);
    if(!receipt.success)throw new BrowserError("SOURCE.BROWSER_PROTOCOL");
    const file=await open(output,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const stat=await file.stat();
      if(!stat.isFile()||stat.size!==receipt.data.bytes||(stat.mode&0o077))throw new BrowserError("SOURCE.BROWSER_SNAPSHOT_INVALID");
      const bytes=Buffer.alloc(stat.size+1);let n=0;
      while(n<bytes.length){const part=await file.read(bytes,n,bytes.length-n,n);if(!part.bytesRead)break;n+=part.bytesRead;}
      signal.throwIfAborted();
      const actual=bytes.subarray(0,n);
      if(n!==stat.size||createHash("sha256").update(actual).digest("hex")!==receipt.data.sha256)throw new BrowserError("SOURCE.BROWSER_SNAPSHOT_INVALID");
      return JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(actual));
    } finally {await file.close();}
  }
}

/** Read exactly an already approved live tab. No navigation, takeover, input, close, or fallback. */
export class EgoRenderedBrowser implements RenderedBrowser {
  readonly sessionId: string;
  readonly egressId: string;
  private readonly config: EgoBrowserConfig;
  private readonly origins: string[];
  private busy = false;
  constructor(config: EgoBrowserConfig, egressId: string, allowedOrigins: readonly string[],
    private readonly runner: EgoCommandRunner = new EgoCliRunner()) {
    this.config = EgoBrowserConfigSchema.parse(config);
    if (!egressId || !allowedOrigins.length || allowedOrigins.length > 20) throw new BrowserError("SOURCE.BROWSER_CONFIG");
    this.origins = [...allowedOrigins];
    for (const origin of this.origins) if (permittedUrl(origin, [origin]).origin !== origin) throw new BrowserError("SOURCE.BROWSER_CONFIG");
    this.sessionId = this.config.sessionId; this.egressId = egressId;
  }
  async read(rawUrl: string, abort: AbortSignal): Promise<RenderedPage> {
    const url = permittedUrl(rawUrl, this.origins).href;
    abort.throwIfAborted();
    if (this.busy) throw new BrowserError("SOURCE.BROWSER_BUSY");
    this.busy = true;
    const signal = AbortSignal.any([abort, AbortSignal.timeout(30000)]);
    const c = this.config;
    // responseStatus is the browser's navigation timing value, not an invented success code.
    const expression = `(() => { const n=performance.getEntriesByType('navigation')[0]; const html=document.documentElement.outerHTML; return {url:location.href,status:n?.responseStatus,contentType:document.contentType,readyState:document.readyState,html:html.length<=2097152?html:null}; })()`;
    const select = c.sdk === "1" ? `
await useOrCreateTaskSpace(${c.taskSpaceId});
const tabs=await listTabs();
const selected=tabs.filter(t=>t.targetId===${JSON.stringify(c.targetId)}&&t.url===${JSON.stringify(url)});
if(selected.length!==1)throw Error('EGO_TARGET_MISMATCH');
await switchTab(selected[0].targetId);
const value=await js(${JSON.stringify(expression)});
const snapshot={taskSpaceId:${c.taskSpaceId},targetId:selected[0].targetId,...value};` : `
const task=await taskSpace(${c.taskSpaceId});
const tabs=await task.tabs();
const selected=tabs.filter(t=>t.targetId===${JSON.stringify(c.targetId)}&&t.url===${JSON.stringify(url)}&&t.label);
if(selected.length!==1)throw Error('EGO_TARGET_MISMATCH');
const value=await task.page(selected[0].label).evaluate(${JSON.stringify(expression)});
const snapshot={taskSpaceId:${c.taskSpaceId},targetId:selected[0].targetId,...value};`;
    try {
      const value = await this.runner.run(c.cliPath, select, signal) as Record<string, unknown> | null;
      signal.throwIfAborted();
      if (!value || value.taskSpaceId !== c.taskSpaceId || value.targetId !== c.targetId || value.url !== url)
        throw new BrowserError("SOURCE.BROWSER_INSTANCE_MISMATCH");
      if (value.readyState !== "complete" || !Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599)
        throw new BrowserError("SOURCE.BROWSER_DOCUMENT_UNVERIFIED");
      if (typeof value.html !== "string" || !value.html || Buffer.byteLength(value.html) > 2097152 || typeof value.contentType !== "string")
        throw new BrowserError("SOURCE.BROWSER_SNAPSHOT_INVALID");
      return { url, status: value.status as number, contentType: value.contentType, html: value.html,
        browserId: `ego-space-${c.taskSpaceId}`, targetId: c.targetId };
    } finally { this.busy = false; }
  }
}
