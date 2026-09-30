import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { EGO_MARKER, pageRoundScript } from "./ego-script.js";

it("retains both body and close failures from a task-owned script without a real browser", async () => {
  const messages: Record<string, unknown>[] = [];
  const bodyFailure = { name: "Error", code: "WHOLEFOODS.STORE_NOT_SET", message: "store absent" };
  const closeFailure = Object.assign(new Error("target close refused"), { code: "EIO" });
  const cdpCalls: string[] = [];
  const task = {
    ownership: "agent",
    newPage: async () => ({
      targetId: "owned",
      cdp: async (method: string, params: { source?: string }) => {
        cdpCalls.push(`${method} ${params.source?.includes("geolocation") ? "geolocation" : ""}`);
        return {};
      },
      close: async () => {
        throw closeFailure;
      },
    }),
  };
  const script = pageRoundScript("throw params.failure;", { taskSpaceId: 1, failure: bodyFailure });
  await runInNewContext(`(async () => {${script}})()`, {
    taskSpace: async () => task,
    console: { log: (line: string) => messages.push(JSON.parse(line.slice(EGO_MARKER.length))) },
  });
  // Every task page answers location requests as denied before any site script runs.
  expect(cdpCalls).toEqual(["Page.addScriptToEvaluateOnNewDocument geolocation"]);
  expect(messages.find((message) => message.kind === "result")).toMatchObject({
    targetId: "owned",
    closed: false,
    failure: bodyFailure,
    cleanupFailure: { name: "Error", code: "EIO", message: "target close refused" },
  });
});
