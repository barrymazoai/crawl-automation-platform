import {EventEmitter} from "node:events";
import {it,expect,vi,afterEach} from "vitest";
const state=vi.hoisted(()=>({child:null as any}));
vi.mock("node:child_process",()=>({spawn:()=>state.child}));
import {CodexRpc} from "./codex-rpc.js";
afterEach(()=>vi.useRealTimers());
it("SIGKILL alone is not close proof; await actual close",async()=>{
 vi.useFakeTimers();const c:any=new EventEmitter();c.stdin=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=vi.fn();state.child=c;
 const rpc=new CodexRpc({executable:"unused",args:[],cwd:"/tmp",env:{}});let done=false;
 const pending=rpc.close().then(()=>{done=true;});await vi.advanceTimersByTimeAsync(1001);
 expect(c.kill).toHaveBeenCalledWith("SIGKILL");expect(done).toBe(false);c.emit("close");await pending;expect(done).toBe(true);
});
it("fails closed when no close arrives after escalation",async()=>{
 vi.useFakeTimers();const c:any=new EventEmitter();c.stdin=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();c.kill=vi.fn();state.child=c;
 const rpc=new CodexRpc({executable:"unused",args:[],cwd:"/tmp",env:{}});
 const checked=expect(rpc.close()).rejects.toThrow("TEXT.CODEX_STOP_UNCONFIRMED");await vi.advanceTimersByTimeAsync(6001);await checked;
});
