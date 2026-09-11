import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgoBrowserConfigSchema, EgoRenderedBrowser, EgoCliRunner } from "./ego-browser.js";
const config = { engine: "ego-lite", sdk: "1", cliPath: "/Users/barry/.local/bin/ego-browser", taskSpaceId: 1, targetId: "target", sessionId: "session" } as const;
const url = "https://www.gnc.com/energy/613701.html";
const signal = () => new AbortController().signal;
function fixture() {
  const value = { taskSpaceId: 1, targetId: "target", url, status: 200, contentType: "text/html", readyState: "complete", html: "<html>真实页面</html>" };
  const runner = { run: vi.fn(async () => value) };
  return { value, runner, browser: new EgoRenderedBrowser(config, "ego-host/1", ["https://www.gnc.com"], runner) };
}
describe("Ego already-owned live tab", () => {
  it("reads real status and HTML without navigation, input, takeover or closing", async () => {
    const f = fixture();
    expect(await f.browser.read(url, signal())).toMatchObject({ status: 200, html: f.value.html, browserId: "ego-space-1", targetId: "target" });
    const call = f.runner.run.mock.calls[0] as unknown as [string, string, AbortSignal];
    expect(call[1]).toContain("performance.getEntriesByType");
    expect(call[1]).not.toMatch(/Page.navigate|goto|fetch\(|claimTaskSpace|takeOverTaskSpace|mouse|closeTab|completeTaskSpace/);
    expect(call[1]).toContain('t.targetId==="target"');
  });
  it.each([{ taskSpaceId: 2 }, { targetId: "other" }, { url: "https://www.gnc.com/other" }])("rejects changed identity %j", async patch => {
    const f = fixture(); Object.assign(f.value, patch);
    await expect(f.browser.read(url, signal())).rejects.toThrow("SOURCE.BROWSER_INSTANCE_MISMATCH");
  });
  it.each([0, undefined, 200.5, 600])("does not invent HTTP 200 for status %s", async status => {
    const f = fixture(); Object.assign(f.value, { status });
    await expect(f.browser.read(url, signal())).rejects.toThrow("SOURCE.BROWSER_DOCUMENT_UNVERIFIED");
  });
  it("preserves challenge status for GNC classification", async () => {
    const f = fixture(); f.value.status = 403;
    expect((await f.browser.read(url, signal())).status).toBe(403);
  });
  it("rejects oversized or not-ready snapshots", async () => {
    const f = fixture(); f.value.html = "中".repeat(800000);
    await expect(f.browser.read(url, signal())).rejects.toThrow("SOURCE.BROWSER_SNAPSHOT_INVALID");
    f.value.readyState = "loading";
    await expect(f.browser.read(url, signal())).rejects.toThrow("SOURCE.BROWSER_DOCUMENT_UNVERIFIED");
  });
  it("rejects foreign origins and cancelled work without launching CLI", async () => {
    const f = fixture();
    await expect(f.browser.read("https://example.com/", signal())).rejects.toThrow();
    const c = new AbortController(); c.abort(Error("cancelled"));
    await expect(f.browser.read(url, c.signal)).rejects.toThrow("cancelled");
    expect(f.runner.run).not.toHaveBeenCalled();
  });
  it("rejects overlap and ignores late data after cancellation", async () => {
    const f = fixture(); let finish!: (v: typeof f.value) => void;
    f.runner.run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const c = new AbortController(), first = f.browser.read(url, c.signal);
    await expect(f.browser.read(url, signal())).rejects.toThrow("SOURCE.BROWSER_BUSY");
    c.abort(Error("cancelled")); finish(f.value);
    await expect(first).rejects.toThrow("cancelled");
    await expect(f.browser.read(url, signal())).resolves.toMatchObject({status: 200});
  });
  it("propagates user-control refusal without a fallback or retry", async () => {
    const f = fixture(); f.runner.run.mockRejectedValueOnce(Error("SOURCE.BROWSER_USER_CONTROL"));
    await expect(f.browser.read(url, signal())).rejects.toThrow("SOURCE.BROWSER_USER_CONTROL");
    expect(f.runner.run).toHaveBeenCalledTimes(1);
  });
  it("uses separate SDK2 API without adopting unmanaged tabs", async () => {
    const f = fixture(); const browser = new EgoRenderedBrowser({...config,sdk:"2"},"ego-host/1",["https://www.gnc.com"],f.runner);
    await browser.read(url,signal());
    const script=(f.runner.run.mock.calls[0] as unknown as [string,string])[1];
    expect(script).toContain("task.page(selected[0].label).evaluate");
    expect(script).not.toContain("useOrCreateTaskSpace");
    expect(script).not.toContain("adopt");
  });
  it("rejects invalid private browser configuration", () => {
    expect(EgoBrowserConfigSchema.safeParse({...config,cliPath:"relative"}).success).toBe(false);
    expect(EgoBrowserConfigSchema.safeParse({...config,taskSpaceId:0}).success).toBe(false);
    expect(EgoBrowserConfigSchema.safeParse({...config,targetId:"'; injected"}).success).toBe(false);
  });
});

describe("Ego private large snapshot handoff", () => {
  async function fakeCli(body: string) {
    const dir=await mkdtemp(join(tmpdir(),"ego-cli-fixture-"));const cli=join(dir,"ego");
    await writeFile(cli,body,{mode:0o700});return cli;
  }
  it("transfers a large Unicode snapshot by hash without relying on a large log line", async () => {
    const cli=await fakeCli(`#!/bin/sh\nexec '${process.execPath}' --input-type=module\n`);
    const value=await new EgoCliRunner().run(cli,"const snapshot={html:'中文🙂'.repeat(150000),status:200};",signal());
    expect(value).toEqual({html:"中文🙂".repeat(150000),status:200});
  });
  it("accepts SDK1 cliLog on stderr, as observed on Mini", async () => {
    const cli=await fakeCli(`#!/bin/sh\nexec '${process.execPath}' --input-type=module\n`);
    const value=await new EgoCliRunner().run(cli,"const cliLog=s=>console.error(s);const snapshot={status:200,html:'页面'};",signal());
    expect(value).toEqual({status:200,html:"页面"});
  });
  it("rejects malformed CLI receipts", async () => {
    const cli=await fakeCli("#!/bin/sh\necho CRAWLV3_EGO_SNAPSHOT:not-json\n");
    await expect(new EgoCliRunner().run(cli,"",signal())).rejects.toThrow("SOURCE.BROWSER_PROTOCOL");
  });
  it("preserves user-control refusal instead of taking over", async () => {
    const cli=await fakeCli("#!/bin/sh\necho 'user is controlling' >&2\nexit 1\n");
    await expect(new EgoCliRunner().run(cli,"",signal())).rejects.toThrow("SOURCE.BROWSER_USER_CONTROL");
  });
});
