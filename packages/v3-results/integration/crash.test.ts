import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { FileCompletionJournal } from "../src/file-journal.js";
import { OcrResultHandoff } from "../src/handoff.js";
import { MemoryRegistry, setup, signal } from "../src/testing.fixture.js";
const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
const artifactsUrl = new URL("../../v3-artifacts/dist/index.js", import.meta.url).href;
describe("computed completion survives real independent process death", () => {
    it.each(["SIGTERM", "SIGKILL"] as const)("%s after local completion needs only handoff", async (killSignal) => {
        const s = await setup(), counter = join(s.root, "provider-calls.txt");
        const code = `
      import {writeFile} from 'node:fs/promises';
      const [mod,art,root,input,output,counter]=JSON.parse(process.argv[1]);
      const {FileCompletionJournal,OcrResultHandoff}=await import(mod);
      const {FileCopies}=await import(art);
      await writeFile(counter,'one simulated provider invocation',{flag:'wx'});
      const forbidden=async()=>{throw Error('Handoff must not run in producer');};
      const h=new OcrResultHandoff('fixture-r2/1',await FileCopies.open(root+'/cache'),{read:forbidden,create:forbidden},await FileCompletionJournal.open(root+'/journal'),{read:forbidden,register:forbidden});
      await h.capture(input,output,new AbortController().signal);
      process.stdout.write('computed_local\\n');setInterval(()=>{},1000);
    `;
        const child = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify([moduleUrl, artifactsUrl, s.root, s.input, s.output, counter])], { stdio: ["ignore", "pipe", "pipe"] });
        const exit = once(child, "exit");
        let stdout = "", stderr = "";
        child.stderr.on("data", b => { stderr += String(b); });
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(Error(`Producer checkpoint missing: ${stderr}`)), 5000);
                child.stdout.on("data", b => { stdout += String(b); if (stdout.includes("computed_local")) {
                    clearTimeout(timer);
                    resolve();
                } });
                child.once("error", e => { clearTimeout(timer); reject(e); });
                child.once("exit", () => { clearTimeout(timer); if (!stdout.includes("computed_local"))
                    reject(Error(`Producer exited: ${stderr}`)); });
            });
            child.kill(killSignal);
            expect((await exit)[1]).toBe(killSignal);
            const registry = new MemoryRegistry(), restored = new OcrResultHandoff("fixture-r2/1", s.local, s.remote, await FileCompletionJournal.open(join(s.root, "journal")), registry);
            expect(await restored.inspect(s.input, signal())).toMatchObject({ computedLocal: true, artifactDurable: false });
            await restored.uploadMissing(s.input, signal());
            expect(await restored.register(s.input, signal())).toMatchObject({ resultRegistered: true });
            expect(await readFile(counter, "utf8")).toBe("one simulated provider invocation");
            expect(s.remote.writes).toBe(2);
            expect(registry.writes).toBe(1);
        }
        finally {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
                await exit;
            }
        }
    });
});
