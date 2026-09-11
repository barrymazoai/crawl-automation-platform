import { expect, it, vi } from "vitest";
import { EgoNavigatingBrowser } from "./ego-navigation.js";
const url="https://www.gnc.com/brands/focus-fuel/";
const config={engine:"ego-lite" as const,sdk:"1" as const,cliPath:"/Users/barry/.local/bin/ego-browser",taskSpaceId:1,targetId:"target",sessionId:"session"};
it("navigates only exact target then verifies rendered evidence through Ego",async()=>{
  const run=vi.fn().mockResolvedValueOnce({url,targetId:"target",taskSpaceId:1}).mockResolvedValueOnce({url,targetId:"target",taskSpaceId:1,status:200,readyState:"complete",contentType:"text/html",html:"<h1>Brand</h1>"});
  expect((await new EgoNavigatingBrowser(config,"egress",[url],{run}).read(url,AbortSignal.timeout(1000))).html).toContain("Brand");
  expect(run.mock.calls[0]![1]).toContain("gotoAndWait");expect(run.mock.calls[0]![1]).not.toMatch(/claimTaskSpace|openOrReuseTab|fetch\(/);expect(run).toHaveBeenCalledTimes(2);
});
it("URL outside exact discovered grant never invokes browser",async()=>{
  const run=vi.fn();await expect(new EgoNavigatingBrowser(config,"egress",[url],{run}).read("https://www.gnc.com/",AbortSignal.timeout(1000))).rejects.toThrow("URL_REJECTED");expect(run).not.toHaveBeenCalled();
});
it("redirect or different browser identity fails before HTML read",async()=>{
  const run=vi.fn(async()=>({url:"https://www.gnc.com/",targetId:"target",taskSpaceId:1}));
  await expect(new EgoNavigatingBrowser(config,"egress",[url],{run}).read(url,AbortSignal.timeout(1000))).rejects.toThrow("INSTANCE_MISMATCH");expect(run).toHaveBeenCalledOnce();
});
it("no takeover or automatic retry when user owns space",async()=>{
  const run=vi.fn(async()=>{throw Error("SOURCE.BROWSER_USER_CONTROL");});
  await expect(new EgoNavigatingBrowser(config,"egress",[url],{run}).read(url,AbortSignal.timeout(1000))).rejects.toThrow("USER_CONTROL");expect(run).toHaveBeenCalledOnce();
});
