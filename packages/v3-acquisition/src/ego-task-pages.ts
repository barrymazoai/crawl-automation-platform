import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import { ExecutionIdSchema } from "@crawl-automation/v3-contracts";
import { sha256, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { EgoBrowserConfigSchema, EgoCliRunner, type EgoCommandRunner } from "./ego-browser.js";
import { BrowserError } from "./browser.js";

export const EgoTaskSpaceSchema = EgoBrowserConfigSchema.omit({ targetId: true, sessionId: true });
type Space = z.infer<typeof EgoTaskSpaceSchema>;
const Intent = z.strictObject({ taskId: ExecutionIdSchema, space: EgoTaskSpaceSchema, marker: z.string().uuid() });
const Page = Intent.extend({ targetId: EgoBrowserConfigSchema.shape.targetId });
type Page = z.infer<typeof Page>;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const userControl = (error: unknown) => error instanceof Error && error.message === "SOURCE.BROWSER_USER_CONTROL";

/** Task-owned tabs, not a shared fixed target. Caller holds the cross-process browser lease.
 * Journal survives process exit; an uncertain open is never automatically repeated.
 * Closing a tab leaves the shared TaskSpace, Profile, cookies and all other tabs untouched.
 */
export class EgoTaskPages {
  private readonly space: Space;
  constructor(space: Space, private readonly journal: ObjectStore, private readonly runner: EgoCommandRunner = new EgoCliRunner()) {
    this.space = EgoTaskSpaceSchema.parse(space);
  }
  private key(taskId: string, name: string) {
    ExecutionIdSchema.parse(taskId);
    return `v3/browser-pages/${sha256(bytes([this.space, taskId]))}/${name}.json`;
  }
  private async read(taskId: string, name: string, signal: AbortSignal) {
    const saved = await this.journal.read(this.key(taskId, name), 8192, signal);
    return saved ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(saved)) : null;
  }
  private async retain(taskId: string, name: string, value: unknown, signal: AbortSignal) {
    await this.journal.create(this.key(taskId, name), bytes(value), "application/json", signal);
    if (!equal(await this.read(taskId, name, signal), value)) throw new BrowserError("SOURCE.PAGE_JOURNAL_CONFLICT");
  }
  private select() {
    return this.space.sdk === "1" ? `await useOrCreateTaskSpace(${this.space.taskSpaceId});` : `const task=await taskSpace(${this.space.taskSpaceId});`;
  }
  private tabs() { return this.space.sdk === "1" ? "await listTabs()" : "await task.tabs()"; }
  private validate(page: Page, taskId: string) {
    if (page.taskId !== taskId || !equal(page.space, this.space)) throw new BrowserError("SOURCE.PAGE_JOURNAL_CONFLICT");
    return { ...this.space, targetId: page.targetId, sessionId: taskId };
  }
  async open(taskId: string, signal: AbortSignal) {
    ExecutionIdSchema.parse(taskId); signal.throwIfAborted();
    if (await this.read(taskId, "closed", signal)) throw new BrowserError("SOURCE.PAGE_ALREADY_CLOSED");
    const prior = await this.read(taskId, "opened", signal);
    if (prior) return this.validate(Page.parse(prior), taskId);
    const intent = Intent.parse({ taskId, space: this.space, marker: randomUUID() });
    if (await this.journal.create(this.key(taskId, "intent"), bytes(intent), "application/json", signal) !== "created")
      throw new BrowserError("SOURCE.PAGE_OPEN_UNKNOWN");
    if (!equal(await this.read(taskId, "intent", signal), intent)) throw new BrowserError("SOURCE.PAGE_JOURNAL_CONFLICT");
    const markerUrl = `about:blank#crawlv3-${intent.marker}`;
    const create = this.space.sdk === "1"
      ? `await openOrReuseTab(${JSON.stringify(markerUrl)},{wait:true,timeout:10});`
      : `const page=await task.newPage();await page.goto(${JSON.stringify(markerUrl)},{timeout:10000});`;
    const script = `${this.select()}
const before=${this.tabs()};if(before.some(t=>t.url===${JSON.stringify(markerUrl)}))throw Error('EGO_MARKER_COLLISION');
${create}
const after=${this.tabs()};const added=after.filter(t=>!before.some(b=>b.targetId===t.targetId)&&t.url===${JSON.stringify(markerUrl)});
if(added.length!==1)throw Error('EGO_PAGE_OPEN_UNKNOWN');
const snapshot={...${JSON.stringify(intent)},targetId:added[0].targetId};`;
    const page = Page.parse(await this.runner.run(this.space.cliPath, script, signal));
    if (page.marker !== intent.marker) throw new BrowserError("SOURCE.PAGE_JOURNAL_CONFLICT");
    const config = this.validate(page, taskId);
    // Store identity before any site navigation. Recovery never scans/ closes by channel domain.
    await this.retain(taskId, "opened", page, AbortSignal.timeout(10000));
    return config;
  }
  async close(taskId: string, signal: AbortSignal) {
    const prior = await this.read(taskId, "closed", signal);
    if (prior) {
      const page = Page.parse(prior); this.validate(page, taskId);
      return { status: "closed" as const, taskId, targetId: page.targetId };
    }
    const raw = await this.read(taskId, "opened", signal);
    if (!raw) {
      if (await this.read(taskId, "intent", signal)) throw new BrowserError("SOURCE.PAGE_OPEN_UNKNOWN");
      return { status: "not-opened" as const, taskId, targetId: null };
    }
    const page = Page.parse(raw); this.validate(page, taskId);
    await this.retain(taskId, "close-intent", page, signal);
    const close = this.space.sdk === "1" ? "await closeTab(selected[0].targetId);" :
      "if(!selected[0].label)throw Error('EGO_PAGE_OWNERSHIP_UNKNOWN');await task.page(selected[0].label).close();";
    const script = `${this.select()}
const tabs=${this.tabs()};const selected=tabs.filter(t=>t.targetId===${JSON.stringify(page.targetId)});
if(selected.length>1)throw Error('EGO_TARGET_MISMATCH');if(selected.length===1){${close}}
let absent=false;for(let n=0;n<30;n++){if(!(${this.tabs()}).some(t=>t.targetId===${JSON.stringify(page.targetId)})){absent=true;break;}await new Promise(r=>setTimeout(r,100));}
const snapshot={taskId:${JSON.stringify(taskId)},targetId:${JSON.stringify(page.targetId)},taskSpaceId:${this.space.taskSpaceId},absent};`;
    const result = await this.runner.run(this.space.cliPath, script, signal);
    if (!equal(result, { taskId, targetId: page.targetId, taskSpaceId: this.space.taskSpaceId, absent: true }))
      throw new BrowserError("SOURCE.PAGE_CLOSE_UNKNOWN");
    await this.retain(taskId, "closed", page, signal);
    return { status: "closed" as const, taskId, targetId: page.targetId };
  }
  /** Read the already verified close journal without selecting or touching a browser. */
  async closedProof(taskId: string, signal: AbortSignal) {
    const closed = await this.read(taskId, "closed", signal), opened = await this.read(taskId, "opened", signal);
    if (!closed || !opened || !equal(closed, opened)) throw new BrowserError("SOURCE.PAGE_CLOSE_UNKNOWN");
    const page = Page.parse(closed); this.validate(page, taskId);
    return { status: "closed" as const, taskId, targetId: page.targetId };
  }
  /** For a whole browser phase, not a single HTML read when later file tasks still need the page. */
  async using<T>(taskId: string, signal: AbortSignal, work: (page: ReturnType<EgoTaskPages["validate"]>) => Promise<T>): Promise<T> {
    const page = await this.open(taskId, signal);
    let value: T | undefined, failure: unknown;
    try { value = await work(page); } catch (error) { failure = error; }
    // A user-control stop must not be routed around by cleanup.
    if (userControl(failure)) throw failure;
    try { await this.close(taskId, AbortSignal.timeout(15000)); }
    catch (cleanup) { throw new AggregateError([failure, cleanup].filter(Boolean), "SOURCE.PAGE_CLEANUP_PENDING"); }
    if (failure) throw failure;
    return value as T;
  }
}
