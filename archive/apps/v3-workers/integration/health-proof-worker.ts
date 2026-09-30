// Isolated supervisor fixture, never registered as a business Worker.
import { WorkerHealthFile } from "../../../packages/v3-worker-runtime/src/health.js";
if(process.env.V3_SUPERVISOR_TEST!=="true"||!process.env.V3_WORKER_HEALTH_FILE)throw Error("Test opt-in required");
const health=new WorkerHealthFile(process.env.V3_WORKER_HEALTH_FILE);
await health.report({event:"WORKER_RUNNING"});
const timer=setInterval(()=>{void health.flush();},1000);
process.once("SIGTERM",()=>{clearInterval(timer);void health.report({event:"WORKER_STOPPED"});});
