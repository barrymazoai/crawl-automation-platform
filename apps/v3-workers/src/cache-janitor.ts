import { existsSync } from "node:fs";
import { opendir, lstat, mkdir, readFile, rm, statfs, writeFile, realpath, rename, copyFile, truncate } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join, sep, resolve, relative, basename } from "node:path";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { z } from "zod";

// Regenerable caches are the only thing a node may delete on its own. Evidence (any `journal`), the ledger's data
// directory and anything outside `root` stay untouched: a run that cannot prove a target is a cache deletes nothing.
// The line stopping because a disk filled up costs more than re-doing an OCR call, so the sweep runs on a timer and
// switches to shorter retention while free space is under the floor.
const path = z.string().refine(isAbsolute);
const PROTECTED = ["journal", "postgres-data", "crawl-data"];

export const JanitorRuleSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  dir: path,
  /** `file`: entries directly inside `dir`. `directory`: whole child directories, for a per-turn work dir. */
  kind: z.enum(["file", "directory"]),
  /** Only entries whose name carries this suffix (".blob") or prefix ("execution-") are candidates. */
  suffix: z.string().min(1).max(32).optional(),
  prefix: z.string().min(1).max(32).optional(),
  keepMinutes: z.number().int().min(1).max(43200),
  /** Retention while free space is under the floor. Never longer than `keepMinutes`. */
  urgentKeepMinutes: z.number().int().min(1).max(43200),
  requireOwner: z.boolean().default(true),
});
export type JanitorRule = z.infer<typeof JanitorRuleSchema>;

export const JanitorConfigSchema = z.strictObject({
  root: path,
  logPath: path,
  floorGB: z.number().int().min(1).max(4096),
  rules: z.array(JanitorRuleSchema).min(1).max(128),
  intervalSeconds: z.number().int().min(30).max(86400).default(3600),
  logFiles: z.array(path).max(128).default([]),
  logMaxBytes: z.number().int().min(1048576).default(20 * 1024 ** 2),
  /** Codex writes an unbounded diagnostic log DB (openai/codex#29588) that no setting turns off, and a multi-GB one
   * makes its own startup time out (#27741). It lives outside `root`, so only these exact names may be removed, and
   * only while no Codex process is running — an open SQLite file must not be deleted underneath it. */
  codexLog: z.strictObject({ home: path, maxBytes: z.number().int().min(1048576) }).optional(),
});
export type JanitorConfig = z.infer<typeof JanitorConfigSchema>;

export type Entry = { name: string; kind: "file" | "dir" | "other"; mtimeMs: number };
export const CODEX_LOG_FILES = ["logs_2.sqlite", "logs_2.sqlite-wal", "logs_2.sqlite-shm"];

/** A rule may only name a cache directory strictly inside the release root, never evidence or a data directory. */
export function assertRuleSafe(root: string, rule: JanitorRule): void {
  if(resolve(root)!==root || resolve(rule.dir)!==rule.dir)throw Error('JANITOR.NONCANONICAL_PATH');
  const inside = rule.dir.startsWith(root.endsWith(sep) ? root : root + sep);
  if (!inside || rule.dir === root) throw Error("JANITOR.RULE_OUTSIDE_ROOT");
  const segments = rule.dir.slice(root.length).split(sep).filter(Boolean);
  if (!segments.length) throw Error("JANITOR.RULE_OUTSIDE_ROOT");
  if (segments.some(s => PROTECTED.includes(s) || /journal|evidence/i.test(s))) throw Error("JANITOR.RULE_PROTECTED_PATH");
  if (rule.kind === "directory" && !rule.prefix) throw Error("JANITOR.DIRECTORY_RULE_NEEDS_PREFIX");
  if (rule.urgentKeepMinutes > rule.keepMinutes) throw Error("JANITOR.URGENT_RETENTION_LONGER");
}

/** Names under `rule.dir` this sweep may remove: right shape, right age, never a symlink or anything else. */
export function planRemovals(rule: JanitorRule, entries: Entry[], nowMs: number, urgent: boolean): string[] {
  const keepMs = (urgent ? rule.urgentKeepMinutes : rule.keepMinutes) * 60_000;
  const wanted = rule.kind === "directory" ? "dir" : "file";
  return entries.filter(e => e.kind === wanted
    && (!rule.suffix || e.name.endsWith(rule.suffix))
    && (!rule.prefix || e.name.startsWith(rule.prefix))
    && nowMs - e.mtimeMs >= keepMs).map(e => e.name);
}

export const urgent = (freeBytes: number, floorGB: number) => freeBytes < floorGB * 1024 ** 3;

/** The log DB is removable only when it has actually grown past the cap and nothing is holding it open. */
export function codexLogRemovable(sizeBytes: number, maxBytes: number, codexRunning: boolean): boolean {
  return !codexRunning && sizeBytes > maxBytes;
}

// Every insert into Codex's diagnostic log is dropped at the database; the statement itself still succeeds, so Codex
// keeps working (verified against codex-cli 0.153 in both exec and app-server mode). Re-applied every sweep: a Codex
// upgrade or a removed oversized DB brings back a log table without it.
export const LOG_GUARD_SQL = "CREATE TRIGGER IF NOT EXISTS block_log_inserts BEFORE INSERT ON logs BEGIN SELECT RAISE(IGNORE); END;";

/** Idempotent. A DB Codex has not created yet is left alone rather than created with a schema Codex does not own. */
export function guardCodexLog(file: string): "guarded" | "absent" | "no_logs_table" {
  if (!existsSync(file)) return "absent";
  const db = new DatabaseSync(file, { timeout: 5000 });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='logs'").get()) return "no_logs_table";
    db.exec(LOG_GUARD_SQL);
    return "guarded";
  } finally { db.close(); }
}

/** Offline diagnostic-only rebuild. Preserve Codex migration metadata and the
 * exact schema, without deleting millions of indexed rows on a slow disk. */
export async function compactCodexLog(file: string) {
  const scratch=file+'.rebuild-'+randomUUID(),old=new DatabaseSync(file,{timeout:5000});
  let next:DatabaseSync|undefined;
  try {
    const schema=old.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END").all() as {type:string;name:string;sql:string}[];
    if(schema.some(r=>r.type==='table'&&!['logs','_sqlx_migrations'].includes(r.name)))throw Error('JANITOR.CODEX_SCHEMA_CHANGED');
    await writeFile(scratch,'',{flag:'wx',mode:0o600});next=new DatabaseSync(scratch);
    for(const row of schema)next.exec(row.sql);
    if(schema.some(r=>r.name==='_sqlx_migrations')){
      const metadata=old.prepare('SELECT * FROM _sqlx_migrations LIMIT 1001').all();
      if(metadata.length>1000)throw Error('JANITOR.CODEX_SCHEMA_CHANGED');
      for(const row of metadata){const keys=Object.keys(row),quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
        next.prepare('INSERT INTO _sqlx_migrations('+keys.map(quote).join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k]!));}
    }
    next.exec(LOG_GUARD_SQL);
    for(const pragma of ['user_version','application_id']){const value=Object.values(old.prepare('PRAGMA '+pragma).get()!)[0];if(typeof value!=='number')throw Error('JANITOR.CODEX_SCHEMA_CHANGED');next.exec('PRAGMA '+pragma+'='+value);}
    next.close();next=undefined;
    const checkpoint=old.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if(checkpoint?.busy)throw Error('JANITOR.CODEX_LOG_BUSY');
  }catch(error){next?.close();await rm(scratch,{force:true});throw error;}finally{old.close();}
  try {
    // Recheck immediately before replacement; never remove an active provider's DB.
    if(await codexRunning())throw Error('JANITOR.CODEX_LOG_BUSY');
    for(const suffix of ['-wal','-shm']){const st=await lstat(file+suffix).catch(()=>null);if(st?.isSymbolicLink()||(suffix==='-wal'&&st&&st.size>0))throw Error('JANITOR.CODEX_LOG_BUSY');if(st)await rm(file+suffix);}
    await rename(scratch,file);
  }finally{await rm(scratch,{force:true});}
}

export function isCodexProcessLine(line:string,platform=process.platform):boolean {
  // The machine-wide Windows sandbox service runs as a system service, not as
  // an app-server using this project's CODEX_HOME. It is never stopped here.
  if(platform==='win32'&&/^"codex-windows-sandbox-service\.exe"/i.test(line.trim()))return false;
  return platform==='win32'?/^"codex(?:[-_.][^"]*)?\.exe"/i.test(line.trim()):/^codex(?:[-_.].*)?$/.test(basename(line.trim()));
}

export async function codexRunning(): Promise<boolean> {
  // Failure to inspect processes is an error, never proof that the database is idle.
  const exec = promisify(execFile);
  const out = process.platform === 'win32'
    ? await exec('tasklist.exe', ['/FO','CSV','/NH'], {timeout:15000,maxBuffer:4000000})
    : await exec('/bin/ps', ['-axo','comm='], {timeout:10000,maxBuffer:4000000});
  return out.stdout.split('\n').some(line=>isCodexProcessLine(line));
}

async function stoppedWorkspace(dir: string, noCodexProcesses: boolean): Promise<boolean> {
  try {
    const file=join(dir,'.crawler-owner.json'),s=await lstat(file);
    if(!s.isFile()||s.isSymbolicLink()||s.size>2048)return false;
    const owner=JSON.parse(await readFile(file,'utf8'));
    if(owner.codec!=='codex-workspace/1'||!Number.isInteger(owner.pid)||owner.pid<1)return false;
    const receipt=join(dir,'.crawler-stopped.json'),r=await lstat(receipt).catch(()=>null);
    if(r?.isFile()&&!r.isSymbolicLink()&&r.size<2048&&JSON.parse(await readFile(receipt,'utf8')).codec==='codex-workspace-stopped/1')return true;
    // A dead Worker can leave an orphan provider. Only infer safety from a dead
    // owner when process inspection proved that no Codex process remains.
    if(!noCodexProcesses)return false;
    try {process.kill(owner.pid,0);return false;}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH';}
  }catch{return false;}
}

/** Only diagnostic stdout/stderr files explicitly named in private configuration. */
async function rotateLog(root: string,file: string,max: number) {
  assertRuleSafe(root,{id:'log',dir:resolve(file),kind:'file',keepMinutes:1,urgentKeepMinutes:1,requireOwner:true});
  const s=await lstat(file).catch(()=>null);if(!s||s.size<=max)return false;
  if(!s.isFile()||s.isSymbolicLink()||await realpath(file)!==resolve(file))throw Error('JANITOR.LOG_PATH');
  for(let n=3;n>=1;n--){const old=file+'.'+n,st=await lstat(old).catch(()=>null);if(st&&(!st.isFile()||st.isSymbolicLink()))throw Error('JANITOR.LOG_PATH');if(st){if(n===3)await rm(old);else await rename(old,file+'.'+(n+1));}}
  // Preserve the open append-only descriptor. Business evidence lives in journals/R2.
  await copyFile(file,file+'.1');await truncate(file,0);return true;
}

const listing = async (dir: string, signal: AbortSignal): Promise<Entry[]> => {
  const out: Entry[] = [];
  try {
    for await (const e of await opendir(dir)) {
      signal.throwIfAborted();
      if (e.isSymbolicLink()) continue; // never follow a link out of the cache
      const s = await lstat(join(dir, e.name)).catch(() => null);
      if (!s) continue;
      out.push({ name: e.name, kind: s.isDirectory() ? "dir" : s.isFile() ? "file" : "other", mtimeMs: s.mtimeMs });
    }
  } catch (e) { if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e; }
  return out;
};

const size = async (file: string) => (await lstat(file).catch(() => null))?.size ?? 0;

export type SweepResult = { freeGBBefore: number; freeGBAfter: number; urgent: boolean; apply: boolean;
  rules: { id: string; candidates: number; removed: number; bytes: number }[];
  codexLog?: { sizeBytes: number; removed: boolean; reason: string; guard: string } };

/** One pass. `apply: false` reports exactly what it would remove and touches nothing. */
export async function sweep(raw: z.input<typeof JanitorConfigSchema>, opts: { apply: boolean; codexRunning: boolean; now?: number },
  signal: AbortSignal): Promise<SweepResult> {
  const config=JanitorConfigSchema.parse(raw);
  for (const rule of config.rules) assertRuleSafe(config.root, rule);
  if(await realpath(config.root)!==resolve(config.root))throw Error('JANITOR.SYMLINK_ROOT');
  const free = async () => { const s = await statfs(config.root); return Number(s.bsize) * Number(s.bavail); };
  const freeBefore = await free(), now = opts.now ?? Date.now(), mode = urgent(freeBefore, config.floorGB);
  const rules: SweepResult["rules"] = [];
  for (const rule of config.rules) {
    signal.throwIfAborted();
    const actual=await realpath(rule.dir).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(actual!==null&&actual!==resolve(rule.dir))throw Error('JANITOR.SYMLINK_RULE');
    const entries = await listing(rule.dir, signal);
    const names = planRemovals(rule, entries, now, mode);
    let removed = 0, bytes = 0;
    for (const name of names) {
      signal.throwIfAborted();
      const target = join(rule.dir, name);
      const current=await lstat(target).catch(()=>null);
      if(!current||current.isSymbolicLink()||now-current.mtimeMs<(mode?rule.urgentKeepMinutes:rule.keepMinutes)*60000)continue;
      if(rule.kind==='directory'&&rule.requireOwner&&!await stoppedWorkspace(target,!opts.codexRunning))continue;
      if (rule.kind === "file") bytes += await size(target);
      if (!opts.apply) continue;
      // A file the pipeline took back is not an error; the next sweep sees it again.
      try { await rm(target, { recursive: rule.kind === "directory", force: true }); removed++; } catch { /* skipped */ }
    }
    rules.push({ id: rule.id, candidates: names.length, removed, bytes });
  }
  let codexLog: SweepResult["codexLog"];
  if (config.codexLog) {
    const home = config.codexLog.home;
    const total = (await Promise.all(CODEX_LOG_FILES.map(n => size(join(home, n))))).reduce((a, b) => a + b, 0);
    const removable = codexLogRemovable(total, config.codexLog.maxBytes, opts.codexRunning);
    const reason = opts.codexRunning ? "codex_running" : total > config.codexLog.maxBytes ? "oversized" : "within_cap";
    const file=join(home,CODEX_LOG_FILES[0]!);
    const fileStat=await lstat(file).catch(()=>null);
    if(fileStat?.isSymbolicLink()||(fileStat&&await realpath(file)!==resolve(file)))throw Error('JANITOR.CODEX_LOG_PATH');
    // A locked DB is retried next sweep; guarding must never fail the sweep that just freed the disk.
    let guard = "dry_run";
    let compacted=false;
    if (opts.apply) { try {
      guard = guardCodexLog(file);
      if(removable&&guard==='guarded'){
        await compactCodexLog(file);compacted=true;
      }
    } catch { guard = "busy"; } }
    codexLog = { sizeBytes: total, removed: compacted, reason, guard };
  }
  const result: SweepResult = { freeGBBefore: +(freeBefore / 1024 ** 3).toFixed(1),
    freeGBAfter: +((await free()) / 1024 ** 3).toFixed(1), urgent: mode, apply: opts.apply, rules,
    ...(codexLog ? { codexLog } : {}) };
  await mkdir(join(config.logPath, ".."), { recursive: true }).catch(() => {});
  if(opts.apply)for(const file of [...new Set([...config.logFiles,config.logPath])])await rotateLog(config.root,file,config.logMaxBytes);
  await writeFile(config.logPath, JSON.stringify({ at: new Date(now).toISOString(), event: "JANITOR_SWEPT", ...result }) + "\n",
    { flag: "a", mode: 0o600 });
  return result;
}

if (process.argv[1]?.endsWith("cache-janitor.js")) {
  const [configPath, mode, watch] = process.argv.slice(2);
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort()); process.once("SIGINT", () => controller.abort());
  const run = async () => {
    if (!configPath) throw Error("JANITOR.CONFIG_REQUIRED");
    if (mode && !["--dry-run", "--apply"].includes(mode)) throw Error("JANITOR.MODE_INVALID");
    const config = JanitorConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
    if(watch&&watch!=='--watch')throw Error('JANITOR.MODE_INVALID');
    const lock=config.logPath+'.owner.json';
    await mkdir(join(config.logPath,'..'),{recursive:true,mode:0o700});
    if(watch)await writeFile(lock,JSON.stringify({pid:process.pid,at:new Date().toISOString()}),{mode:0o600,flag:'wx'});
    try{do{
      try{console.log(JSON.stringify(await sweep(config, { apply: mode === "--apply", codexRunning:await codexRunning() }, controller.signal)));}
      catch(error){if(!watch)throw error;console.error(JSON.stringify({event:'JANITOR_SWEEP_FAILED',code:error instanceof Error&&error.message.startsWith('JANITOR.')?error.message:'JANITOR.UNAVAILABLE'}));}
      if(!watch)break;
      await delay(config.intervalSeconds*1000,undefined,{signal:controller.signal}).catch(e=>{if(!controller.signal.aborted)throw e;});
    }while(!controller.signal.aborted);}finally{if(watch)await rm(lock,{force:true});}
  };
  run().catch(error => {
    console.error(JSON.stringify({ event: "JANITOR_FAILED", code: error instanceof Error && error.message.startsWith("JANITOR.")
      ? error.message : "JANITOR.UNEXPECTED_ERROR", errorType: error?.name, message: String(error?.message).slice(0, 200) }));
    process.exitCode = 1;
  });
}
