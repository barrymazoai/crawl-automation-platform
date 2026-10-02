import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EgoPages } from "./ego-pages.js";
import { EGO_MARKER, READ_PAGE_BODY, closeTargetScript, pageRoundScript } from "./ego-script.js";

/** A stand-in for the `ego-browser` command: records the script it is given and prints the scripted lines. */
async function fakeEgo(lines: unknown[], exitCode = 0) {
  const folder = await mkdtemp(join(tmpdir(), "fake-ego-"));
  const cliPath = join(folder, "ego-browser");
  const stdinPath = join(folder, "stdin.js");
  const printed = lines.map((line) => EGO_MARKER + JSON.stringify(line));
  const source = `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  if (Buffer.concat(chunks).toString().includes('kind: "health"')) {
    console.log(${JSON.stringify(EGO_MARKER)} + JSON.stringify({kind: "health", code: null, targets: []}));
    return;
  }
  require("node:fs").writeFileSync(${JSON.stringify(stdinPath)}, Buffer.concat(chunks));
  console.log("ego runtime log line");
  for (const line of ${JSON.stringify(printed)}) console.log(line);
  process.exit(${exitCode});
});`;
  await writeFile(cliPath, source);
  await chmod(cliPath, 0o755);
  const pages = new EgoPages({ cliPath, taskSpaceId: 7, roundTimeoutMs: 10_000 });
  return { pages, script: () => readFile(stdinPath, "utf8") };
}

const signal = () => AbortSignal.timeout(20_000);
const drawn = {
  url: "https://www.wholefoodsmarket.com/grocery/product/x-b0096m5pbw",
  status: 200,
  html: "<html><body><h1>Omega</h1></body></html>",
  ready: true,
  scroll: { rounds: 0, ended: "none" },
};

describe("Ego task pages", () => {
  it("reads a page in its own task page, closed before it returns", async () => {
    const ego = await fakeEgo([
      { kind: "opened", targetId: "T1" },
      { kind: "result", targetId: "T1", closed: true, failure: null, value: drawn },
    ]);
    const page = await ego.pages.read(
      { url: drawn.url, readySelector: "h1", timeoutMs: 5_000 },
      signal(),
    );
    expect(page).toEqual(drawn);
    const script = await ego.script();
    expect(script).toContain('"taskSpaceId":7');
    expect(script).toContain(JSON.stringify(drawn.url));
  });

  it("stops without touching the space when the user has taken control", async () => {
    const ego = await fakeEgo([{ kind: "stop", reason: "user-control" }]);
    await expect(
      ego.pages.read({ url: drawn.url, readySelector: "h1", timeoutMs: 5_000 }, signal()),
    ).rejects.toMatchObject({
      code: "BROWSER.USER_CONTROL",
    });
  });

  it("names the page to close when a round dies after opening it", async () => {
    const ego = await fakeEgo([{ kind: "opened", targetId: "T9" }], 1);
    await expect(
      ego.pages.read({ url: drawn.url, readySelector: "h1", timeoutMs: 5_000 }, signal()),
    ).rejects.toMatchObject({
      code: "BROWSER.PAGE_CLEANUP_PENDING",
      details: { opened: ["T9"] },
    });
  });

  it("never reports a page as closed unless the tab is confirmed gone", async () => {
    const ego = await fakeEgo([
      { kind: "result", targetId: "T2", closed: false, failure: null, value: drawn },
    ]);
    await expect(
      ego.pages.read({ url: drawn.url, readySelector: "h1", timeoutMs: 5_000 }, signal()),
    ).rejects.toMatchObject({
      code: "BROWSER.PAGE_CLEANUP_PENDING",
      details: { targetId: "T2" },
    });
  });

  it("reports a round's own failure by its code, not its words", async () => {
    const failure = { name: "Error", code: "WHOLEFOODS.STORE_NOT_SET" };
    const ego = await fakeEgo([
      { kind: "result", targetId: "T3", closed: true, failure, value: null },
    ]);
    await expect(ego.pages.round("return 1;", {}, signal())).rejects.toMatchObject({
      code: "BROWSER.UNAVAILABLE",
      details: { failure },
    });
  });

  it("retains cleanup pending when a runtime answered nothing", async () => {
    const ego = await fakeEgo([], 3);
    await expect(ego.pages.round("return 1;", {}, signal())).rejects.toMatchObject({
      code: "BROWSER.PAGE_CLEANUP_PENDING",
      details: { interrupted: "BROWSER.UNAVAILABLE" },
    });
  });

  it("does not pass a partial page to content parsing after an uncoded readiness failure", async () => {
    const failure = { name: "Error", code: null, message: "connection lost" };
    const ego = await fakeEgo([
      {
        kind: "result",
        targetId: "T1",
        closed: true,
        failure: null,
        value: { ...drawn, ready: false, readinessFailure: failure },
      },
    ]);
    await expect(
      ego.pages.read({ url: drawn.url, readySelector: "h1", timeoutMs: 5000 }, signal()),
    ).rejects.toMatchObject({
      code: "BROWSER.UNAVAILABLE",
      category: "RUNTIME",
      details: { failure },
    });
  });

  it("refuses settings without an absolute command path", () => {
    expect(() => new EgoPages({ cliPath: "ego-browser", taskSpaceId: 7 })).toThrow(
      expect.objectContaining({ code: "BROWSER.CONFIG_INVALID" }),
    );
  });
});

describe("Ego round scripts", () => {
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;

  it("are valid scripts for the Ego runtime, with values passed as JSON", () => {
    const params = { taskSpaceId: 7, read: { url: "https://example.test/'); evil('" } };
    for (const script of [
      pageRoundScript(READ_PAGE_BODY, params),
      closeTargetScript({ taskSpaceId: 7, targetId: "T1" }),
    ]) {
      expect(() => new AsyncFunction(script)).not.toThrow();
    }
    expect(pageRoundScript("return 1;", params)).toContain(JSON.stringify(params));
  });
});
