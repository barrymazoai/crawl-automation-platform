import { expect, it, vi } from "vitest";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { EgoTaskPages } from "./ego-task-pages.js";
const space = { engine: "ego-lite" as const, sdk: "1" as const, cliPath: "/ego-browser", taskSpaceId: 1 };
const signal = () => new AbortController().signal;
class Memory implements ObjectStore {
  data = new Map<string, Uint8Array>();
  async read(key: string) { return this.data.get(key) ?? null; }
  async create(key: string, value: Uint8Array) { if (this.data.has(key)) return "exists" as const; this.data.set(key, value); return "created" as const; }
}
function setup(sdk: "1" | "2" = "1") {
  const journal = new Memory();
  const run = vi.fn(async (_cli: string, script: string, _signal: AbortSignal): Promise<unknown> => {
    if (script.includes("EGO_MARKER_COLLISION")) {
      const intent = JSON.parse(Buffer.from([...journal.data.entries()].find(([k]) => k.endsWith("/intent.json"))![1]).toString());
      return { ...intent, targetId: "owned-target" };
    }
    return { taskId: "test-page", targetId: "owned-target", taskSpaceId: 1, absent: true };
  });
  return { journal, run, pages: new EgoTaskPages({ ...space, sdk }, journal, { run }) };
}
it.each(["1", "2"] as const)("SDK %s closes a task-owned tab after work, not the shared space", async sdk => {
  const f = setup(sdk);
  expect(await f.pages.using("test-page", signal(), async page => { expect(page.targetId).toBe("owned-target"); return "saved"; })).toBe("saved");
  const script = f.run.mock.calls[1]![1]; expect(script).toContain("owned-target"); expect(script).toContain("absent");
  expect(script).not.toMatch(/completeTaskSpace|finish\(|claimTaskSpace|takeOverTaskSpace|clearCookies|Browser.close/);
});
it("closes after failure without replacing the original work error", async () => {
  const f = setup(); await expect(f.pages.using("test-page", signal(), async () => { throw Error("source failed"); })).rejects.toThrow("source failed");
  expect(f.run).toHaveBeenCalledTimes(2);
});
it("uses a separate live cleanup signal after task cancellation", async () => {
  const f = setup(), controller = new AbortController();
  await expect(f.pages.using("test-page", controller.signal, async () => { controller.abort(); throw Error("cancelled"); })).rejects.toThrow("cancelled");
  expect(f.run.mock.calls[1]![2].aborted).toBe(false);
});
it("never routes around a user control hard stop to close", async () => {
  const f = setup(); await expect(f.pages.using("test-page", signal(), async () => { throw Error("SOURCE.BROWSER_USER_CONTROL"); })).rejects.toThrow("USER_CONTROL");
  expect(f.run).toHaveBeenCalledOnce();
});
it("uncertain open cannot open a second tab", async () => {
  const f = setup(); f.run.mockRejectedValueOnce(Error("lost open ack"));
  await expect(f.pages.open("test-page", signal())).rejects.toThrow("lost open ack");
  await expect(f.pages.open("test-page", signal())).rejects.toThrow("PAGE_OPEN_UNKNOWN"); expect(f.run).toHaveBeenCalledOnce();
});
it("new process can close the recorded exact target, and closed task cannot reopen", async () => {
  const f = setup(); await f.pages.open("test-page", signal());
  const cold = new EgoTaskPages(space, f.journal, { run: f.run });
  expect(await cold.close("test-page", signal())).toMatchObject({ status: "closed" });
  await cold.close("test-page", signal()); expect(f.run).toHaveBeenCalledTimes(2);
  await expect(cold.open("test-page", signal())).rejects.toThrow("PAGE_ALREADY_CLOSED");
});
it("does not claim cleanup on an unconfirmed close receipt", async () => {
  const f = setup(); await f.pages.open("test-page", signal()); f.run.mockResolvedValueOnce({ taskId: "test-page", targetId: "owned-target", taskSpaceId: 1, absent: false });
  await expect(f.pages.close("test-page", signal())).rejects.toThrow("PAGE_CLOSE_UNKNOWN");
  expect([...f.journal.data.keys()].some(k => k.endsWith("/closed.json"))).toBe(false);
});
it("successful business work is not reported as a fully cleaned task if cleanup fails", async () => {
  const f = setup(), run = f.run.getMockImplementation()!;
  f.run.mockImplementation(async (...args) => { if (!args[1].includes("EGO_MARKER_COLLISION")) throw Error("close failed"); return run(...args); });
  await expect(f.pages.using("test-page", signal(), async () => "saved")).rejects.toThrow("PAGE_CLEANUP_PENDING");
});

it('cold cloud publisher reads the exact verified close proof without a browser call',async()=>{
 const f=setup();await f.pages.open('test-page',signal());
 await expect(f.pages.closedProof('test-page',signal())).rejects.toThrow('PAGE_CLOSE_UNKNOWN');
 await f.pages.close('test-page',signal());f.run.mockClear();
 const cold=new EgoTaskPages(space,f.journal,{run:f.run});expect(await cold.closedProof('test-page',signal())).toMatchObject({status:'closed',targetId:'owned-target'});expect(f.run).not.toHaveBeenCalled();
 const key=[...f.journal.data.keys()].find(k=>k.endsWith('/closed.json'))!;
 const bad=JSON.parse(Buffer.from(f.journal.data.get(key)!).toString());bad.targetId='foreign-target';f.journal.data.set(key,Buffer.from(JSON.stringify(bad)));
 await expect(cold.closedProof('test-page',signal())).rejects.toThrow('PAGE_CLOSE_UNKNOWN');expect(f.run).not.toHaveBeenCalled();
});
