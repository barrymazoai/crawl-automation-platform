import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgoSettingsSchema } from "../ego-settings.js";

export interface FakeEgoState {
  mode: "ready" | "down" | "user" | "missing" | "hang";
  tabs: { targetId: string; label: string; openedBy: string }[];
  visits: number;
  closed: string[];
  pid?: number;
  childPid?: number;
}

/** Executes the actual generated SDK scripts in a disposable process, with no browser or network. */
export async function fakeEgoRuntime() {
  const folder = await mkdtemp(join(tmpdir(), "ego-offline-"));
  const statePath = join(folder, "state.json");
  const cliPath = join(folder, "ego-browser");
  const initial: FakeEgoState = { mode: "ready", tabs: [], visits: 0, closed: [] };
  await writeFile(statePath, JSON.stringify(initial));
  await writeFile(cliPath, `#!${process.execPath}\n${runtimeSource(statePath)}`);
  await chmod(cliPath, 0o755);
  return {
    settings: EgoSettingsSchema.parse({
      cliPath,
      taskSpaceId: 6,
      probeTimeoutMs: 300,
      cleanupTimeoutMs: 300,
      noPageSettleMs: 0,
      killGraceMs: 50,
    }),
    read: async (): Promise<FakeEgoState> => JSON.parse(await readFile(statePath, "utf8")),
    write: async (state: FakeEgoState) => writeFile(statePath, JSON.stringify(state)),
    dispose: () => rm(folder, { recursive: true, force: true }),
  };
}

const HANG_PROCESS = `  if (state.mode === "hang") {
    const child = require("node:child_process").spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 100)"], {stdio: "inherit"});
    state.childPid = child.pid; save();
    process.on("SIGTERM", () => {}); setInterval(() => {}, 100); return;
  }
`;

function runtimeSource(statePath: string): string {
  return `const fs = require("node:fs");
const path = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(path));
const save = () => fs.writeFileSync(path, JSON.stringify(state));
state.pid = process.pid; save();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const listTaskSpaces = async () => {
  if (state.mode === "down") fail("ECONNREFUSED");
  if (state.mode === "missing") return [];
  return [{id: 6, ownership: state.mode === "user" ? "user" : "agent"}];
};
const page = tab => ({
  ...tab, cdp: async () => ({}),
  goto: async url => {
    state.visits++; save();
    if (url === "disconnect") { state.mode = "down"; save(); fail("ECONNRESET"); }
    if (url === "takeover") { state.mode = "user"; save(); fail("USER_CONTROL"); }
    if (url === "crash") fail("TARGET_CRASHED");
  },
  close: async () => { state.closed.push(tab.targetId); state.tabs = state.tabs.filter(item => item.targetId !== tab.targetId); save(); }
});
const task = {
  ownership: "agent", tabs: async () => state.tabs,
  newPage: async () => { const tab = {targetId: "owned-page", label: "p2", openedBy: "agent"}; state.tabs.push(tab); save(); return page(tab); },
  page: label => page(state.tabs.find(tab => tab.label === label)),
};
const taskSpace = async id => { if (id !== 6) fail("WRONG_SPACE"); await listTaskSpaces(); return task; };
const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", async () => {
${HANG_PROCESS}
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction("listTaskSpaces", "taskSpace", Buffer.concat(chunks).toString())(listTaskSpaces, taskSpace);
  } catch (error) { console.error(error); process.exitCode = 1; }
});`;
}
