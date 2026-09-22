import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, utimes, readdir, realpath, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertRuleSafe, codexLogRemovable, guardCodexLog, planRemovals, sweep, urgent,
  type Entry, type JanitorRule } from "./cache-janitor.js";

const root = "/live/release";
const rule = (over: Partial<JanitorRule> = {}): JanitorRule => ({ id: "source-cache", dir: root + "/source-cache",
  kind: "file", suffix: ".blob", keepMinutes: 120, urgentKeepMinutes: 30, requireOwner:true, ...over });
const entry = (name: string, ageMinutes: number, kind: Entry["kind"] = "file"): Entry =>
  ({ name, kind, mtimeMs: Date.now() - ageMinutes * 60_000 });

describe("a rule names a cache, never evidence", () => {
  it("accepts a cache directory inside the release root", () => {
    expect(() => assertRuleSafe(root, rule())).not.toThrow();
  });
  it("refuses a directory outside the root, and the root itself", () => {
    expect(() => assertRuleSafe(root, rule({ dir: "/Users/barry/crawl-data" }))).toThrow("JANITOR.RULE_OUTSIDE_ROOT");
    expect(() => assertRuleSafe(root, rule({ dir: root }))).toThrow("JANITOR.RULE_OUTSIDE_ROOT");
    expect(() => assertRuleSafe(root, rule({ dir: root + "-other/cache" }))).toThrow("JANITOR.RULE_OUTSIDE_ROOT");
  });
  it("refuses evidence and the ledger's own data directory", () => {
    expect(() => assertRuleSafe(root, rule({ dir: root + "/source-journal" }))).toThrow("JANITOR.RULE_PROTECTED_PATH");
    expect(() => assertRuleSafe(root, rule({ dir: root + "/cache/../../outside" }))).toThrow("JANITOR.NONCANONICAL_PATH");
    expect(() => assertRuleSafe(root, rule({ dir: root + "/label/ocr/journal" }))).toThrow("JANITOR.RULE_PROTECTED_PATH");
    expect(() => assertRuleSafe(root, rule({ dir: root + "/postgres-data/18" }))).toThrow("JANITOR.RULE_PROTECTED_PATH");
  });
  it("refuses a directory rule without a prefix, and urgent retention longer than normal", () => {
    expect(() => assertRuleSafe(root, rule({ kind: "directory", suffix: undefined })))
      .toThrow("JANITOR.DIRECTORY_RULE_NEEDS_PREFIX");
    expect(() => assertRuleSafe(root, rule({ urgentKeepMinutes: 240 }))).toThrow("JANITOR.URGENT_RETENTION_LONGER");
  });
});

describe("what one sweep may remove", () => {
  const entries = [entry("a.blob", 10), entry("b.blob", 180), entry("c.blob", 60), entry("notes.txt", 999),
    entry("sub", 999, "dir"), entry("socket", 999, "other")];
  it("takes only cache files past their retention", () => {
    expect(planRemovals(rule(), entries, Date.now(), false)).toEqual(["b.blob"]);
  });
  it("switches to the shorter retention while the disk is under the floor", () => {
    expect(planRemovals(rule(), entries, Date.now(), true)).toEqual(["b.blob", "c.blob"]);
  });
  it("takes whole work directories by prefix, and leaves everything else", () => {
    const work = rule({ id: "model-work", dir: root + "/model-work", kind: "directory", suffix: undefined,
      prefix: "execution-", keepMinutes: 60, urgentKeepMinutes: 15 });
    const dirs = [entry("execution-01", 120, "dir"), entry("execution-02", 5, "dir"), entry("cache", 999, "dir"),
      entry("execution-03.log", 999)];
    expect(planRemovals(work, dirs, Date.now(), false)).toEqual(["execution-01"]);
  });
  it("reads the floor in bytes", () => {
    expect(urgent(39 * 1024 ** 3, 40)).toBe(true);
    expect(urgent(41 * 1024 ** 3, 40)).toBe(false);
  });
});

describe("the Codex diagnostic log", () => {
  it("goes only when it is oversized and nothing holds it open", () => {
    expect(codexLogRemovable(9e9, 2e9, false)).toBe(true);
    expect(codexLogRemovable(9e9, 2e9, true)).toBe(false); // an open SQLite file is never removed
    expect(codexLogRemovable(1e9, 2e9, false)).toBe(false);
  });
  it("drops every new log row once guarded, without failing the insert, and stays guarded", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "codex-log-")), "logs_2.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL)");
    db.exec("INSERT INTO logs(ts,level) VALUES (1,'TRACE')");
    expect(guardCodexLog(file)).toBe("guarded");
    expect(() => db.exec("INSERT INTO logs(ts,level) VALUES (2,'TRACE')")).not.toThrow();
    expect(db.prepare("SELECT count(*) n FROM logs").get()).toEqual({ n: 1 });
    expect(guardCodexLog(file)).toBe("guarded"); // idempotent
    db.close();
  });
  it("never creates a database Codex has not created, nor touches one without a log table", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-log-"));
    expect(guardCodexLog(join(dir, "logs_2.sqlite"))).toBe("absent");
    expect(await readdir(dir)).toEqual([]);
    const other = join(dir, "other.sqlite");
    new DatabaseSync(other).close();
    expect(guardCodexLog(other)).toBe("no_logs_table");
  });
});

describe("a sweep on a real directory", () => {
  const age = async (file: string, minutes: number) => {
    const t = new Date(Date.now() - minutes * 60_000);
    await utimes(file, t, t);
  };
  const fixture = async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "janitor-")));
    await mkdir(join(base, "source-cache"), { recursive: true });
    await mkdir(join(base, "source-journal"), { recursive: true });
    for (const [name, minutes] of [["old.blob", 300], ["fresh.blob", 5]] as const) {
      await writeFile(join(base, "source-cache", name), "x");
      await age(join(base, "source-cache", name), minutes);
    }
    await writeFile(join(base, "source-journal", "evidence.json"), "{}");
    return base;
  };
  const config = (base: string, apply: boolean) => ({ root: base, logPath: join(base, "janitor.log"), floorGB: 1,
    rules: [{ id: "source-cache", dir: join(base, "source-cache"), kind: "file" as const, suffix: ".blob",
      keepMinutes: 120, urgentKeepMinutes: 30 }] });

  it("reports without touching anything in dry-run, then removes exactly those files", async () => {
    const base = await fixture(), signal = new AbortController().signal;
    const dry = await sweep(config(base, false), { apply: false, codexRunning: false }, signal);
    expect(dry.rules[0]).toMatchObject({ id: "source-cache", candidates: 1, removed: 0 });
    expect(await readdir(join(base, "source-cache"))).toHaveLength(2);

    const done = await sweep(config(base, true), { apply: true, codexRunning: false }, signal);
    expect(done.rules[0]).toMatchObject({ candidates: 1, removed: 1 });
    expect(await readdir(join(base, "source-cache"))).toEqual(["fresh.blob"]);
    expect(await readdir(join(base, "source-journal"))).toEqual(["evidence.json"]);
  });
  it("refuses symlinked cache parents and leaves their contents untouched", async () => {
    const base=await fixture();
    await symlink(join(base,'source-journal'),join(base,'linked'));
    const cfg=config(base,true);cfg.rules[0]!.dir=join(base,'linked');
    await expect(sweep(cfg,{apply:true,codexRunning:false},new AbortController().signal)).rejects.toThrow('JANITOR.SYMLINK_RULE');
    expect(await readdir(join(base,'source-journal'))).toEqual(['evidence.json']);
  });
  it("keeps active and unowned model directories; only verified stopped work is disposable", async () => {
    const base=await fixture(),dir=join(base,'model-work');await mkdir(dir);
    for(const name of ['execution-live','execution-stopped','execution-unknown']){
      const p=join(dir,name);await mkdir(p);
      if(name!=='execution-unknown')await writeFile(join(p,'.crawler-owner.json'),JSON.stringify({codec:'codex-workspace/1',pid:process.pid}));
      if(name==='execution-stopped')await writeFile(join(p,'.crawler-stopped.json'),JSON.stringify({codec:'codex-workspace-stopped/1'}));
      await age(p,180);
    }
    await sweep({...config(base,true),rules:[{id:'model-work',dir,kind:'directory',prefix:'execution-',keepMinutes:60,urgentKeepMinutes:15}]},
      {apply:true,codexRunning:true},new AbortController().signal);
    expect((await readdir(dir)).sort()).toEqual(['execution-live','execution-unknown']);
  });
  it("compacts oversized diagnostics while retaining the insert guard and rotates only configured logs", async () => {
    const base=await fixture(),home=join(base,'codex');await mkdir(home);
    const file=join(home,'logs_2.sqlite'),db=new DatabaseSync(file);
    db.exec("CREATE TABLE logs(id INTEGER PRIMARY KEY, message TEXT); INSERT INTO logs VALUES(1,zeroblob(2000000));");db.close();
    const log=join(base,'worker.log');await writeFile(log,'x'.repeat(1100000));
    const result=await sweep({...config(base,true),codexLog:{home,maxBytes:1048576},logFiles:[log],logMaxBytes:1048576},
      {apply:true,codexRunning:false},new AbortController().signal);
    expect(result.codexLog).toMatchObject({removed:true,guard:'guarded'});
    const check=new DatabaseSync(file);check.exec("INSERT INTO logs VALUES(2,'test')");
    expect(check.prepare('SELECT count(*) n FROM logs').get()).toEqual({n:0});check.close();
    expect(await readFile(log,'utf8')).toBe('');expect((await readFile(log+'.1','utf8')).length).toBe(1100000);
  });
});
