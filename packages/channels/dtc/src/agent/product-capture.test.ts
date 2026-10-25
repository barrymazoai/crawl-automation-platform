import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { RetainedPublication, sha256, type ObjectStore } from "@crawl-automation/platform";
import type { ProductSourcePlans } from "@crawl-automation/channels-core";
import { agentPagePreparationModule } from "../../../../platform/src/browser/ego-agent-preparation.js";
import { dtcSitePolicy } from "../site-policy.js";
import { DtcCaptureAgent, type AgentCaptureDependencies } from "./runner.js";
import { DtcAgentProductCapture } from "./product-capture.js";
import { readMovedOriginal } from "./moved-original.js";

const requestedUrl = "https://www.dherbs.com/store/full-body-cleanse-p-1.html";
const actualUrl = "https://www.dherbs.com/featured/dherbs-full-body-cleanse/";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function outputWithMovedReceipt() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "dtc-moved-agent-")));
  roots.push(cwd);
  const root = join(cwd, "capture");
  await mkdir(root);
  const html = "<html><body>Full Body Cleanse</body></html>";
  await mkdir(join(cwd, "native-originals"));
  const receipt = {
    codec: "ego-native-original/1",
    kind: "html",
    url: actualUrl,
    capturedAt: new Date().toISOString(),
    path: `native-originals/${sha256(Buffer.from(html))}.html`,
    byteSize: Buffer.byteLength(html),
    sha256: sha256(Buffer.from(html)),
    observation: { kind: "moved", requestedUrl, actualUrl, targetId: "owned" },
  };
  await writeFile(join(cwd, receipt.path), html);
  const receiptName = "moved.receipt.json";
  const receiptPath = `native-originals/${receiptName}`;
  await writeFile(join(cwd, receiptPath), JSON.stringify(receipt));
  const receiptBytes = await readFile(join(cwd, receiptPath));
  const entry = (path: string, bytes: Uint8Array) => ({
    path: `../${path}`,
    objectKey: `test/${path}`,
    sha256: sha256(bytes),
    byteSize: bytes.length,
    mediaType: path.endsWith(".html") ? "text/html" : "application/json",
  });
  return {
    root,
    prefix: "v3/dtc-agent/test",
    files: [],
    evidenceFiles: [entry(receiptPath, receiptBytes), entry(receipt.path, Buffer.from(html))],
    manifestKey: "v3/dtc-agent/test/capture.json",
  };
}

// Owner 2026-10-25: exercise the generated Ego module and host receipt reader together.
async function navigationMovedOriginal(
  mode: "normal" | "committed",
  landed = { href: actualUrl, redirectCount: 1 },
  expectMove = true,
) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "dtc-navigation-moved-")));
  roots.push(cwd);
  const root = join(cwd, "capture");
  await mkdir(root);
  const modulePath = join(cwd, "browser-preparation.mjs");
  await writeFile(
    modulePath,
    agentPagePreparationModule(
      { taskSpaceId: 6, label: "product", targetId: "owned" },
      {
        outDir: root,
        workDir: cwd,
        nativeOriginalsModuleUrl: new URL(
          "../../../../../crawl-products/lib/ego-native-originals.mjs",
          import.meta.url,
        ).href,
      },
    ),
  );
  const { prepareBrowserRound } = await import(pathToFileURL(modulePath).href);
  const html = "<html><body>Navigation landed here</body></html>";
  const page = {
    cdp: vi.fn(async () => ({})),
    evaluate: vi
      .fn()
      .mockResolvedValueOnce({ installed: true, url: requestedUrl, notification: "denied" })
      .mockResolvedValueOnce({ ...landed, html, readyState: "complete" }),
    goto:
      mode === "normal"
        ? vi.fn(async () => "navigated")
        : vi.fn(async () => {
            throw Object.assign(new Error("navigation committed at destination"), {
              name: "PageNavigationTimeoutError",
            });
          }),
  };
  const { navigate } = await prepareBrowserRound({
    taskSpace: async () => ({
      tabs: async () => [{ label: "product", targetId: "owned", openedBy: "agent" }],
      page: () => page,
    }),
    listTaskSpaces: async () => [{ id: 6, ownership: "agent" }],
  });
  if (expectMove) {
    await expect(navigate(requestedUrl)).rejects.toThrow("SOURCE.PAGE_MOVED");
  } else {
    await expect(navigate(requestedUrl)).resolves.toBe("navigated");
    await expect(readdir(join(cwd, "native-originals"))).rejects.toMatchObject({ code: "ENOENT" });
    return null;
  }
  expect(page.goto).toHaveBeenCalledWith(requestedUrl, {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });
  const files = await readdir(join(cwd, "native-originals"));
  const evidenceFiles = await Promise.all(
    files.map(async (name: string) => {
      const path = `native-originals/${name}`;
      const bytes = await readFile(join(cwd, path));
      return {
        path: `../${path}`,
        objectKey: `test/${path}`,
        sha256: sha256(bytes),
        byteSize: bytes.length,
        mediaType: name.endsWith(".html") ? "text/html" : "application/json",
      };
    }),
  );
  return readMovedOriginal({ root, evidenceFiles, requestedUrl });
}

it.each(["normal", "committed"] as const)(
  "accepts a %s navigation-written moved receipt through the host reader",
  async (mode) => {
    expect(await navigationMovedOriginal(mode)).toMatchObject({
      status: "moved",
      requestedUrl,
      actualUrl,
      html: Buffer.from("<html><body>Navigation landed here</body></html>"),
    });
  },
);

it.each([
  { name: "zero redirect count", href: actualUrl, redirectCount: 0 },
  { name: "different origin", href: "https://other.example/featured/one", redirectCount: 1 },
])("does not retain a moved receipt for $name", async ({ href, redirectCount }) => {
  expect(await navigationMovedOriginal("normal", { href, redirectCount }, false)).toBeNull();
});

it("uses the retained moved receipt even when the model gives a different reason", async () => {
  const agent = new DtcCaptureAgent({} as AgentCaptureDependencies);
  const output = await outputWithMovedReceipt();
  const result = await agent["productOutput"](
    output,
    {
      url: requestedUrl,
      warning: { status: "needs_review", reasonCode: "unrelated", summary: "uncertain" },
    },
    AbortSignal.timeout(5000),
  );
  expect(result).toMatchObject({
    moved: {
      status: "moved",
      requestedUrl,
      actualUrl,
      html: Buffer.from("<html><body>Full Body Cleanse</body></html>"),
    },
  });
});

it("keeps a receipt-less needs_review as DTC.CAPTURE_REVIEW", async () => {
  const agent = new DtcCaptureAgent({} as AgentCaptureDependencies);
  const output = await outputWithMovedReceipt();
  await expect(
    agent["productOutput"](
      { ...output, evidenceFiles: [] },
      {
        url: requestedUrl,
        warning: { status: "needs_review", reasonCode: "SOURCE.PAGE_MOVED", summary: "moved" },
      },
      AbortSignal.timeout(5000),
    ),
  ).rejects.toMatchObject({ code: "DTC.CAPTURE_REVIEW" });
});

it("archives the landed HTML, records the old listing sighting, and names the new address", async () => {
  const data = new Map<string, Uint8Array>();
  const store: ObjectStore = {
    read: async (key) => data.get(key) ?? null,
    create: async (key, bytes) => {
      if (data.has(key)) {
        return "exists";
      }
      data.set(key, bytes);
      return "created";
    },
  };
  const publication = new RetainedPublication(store, store);
  const site = dtcSitePolicy({
    siteKey: "www.dherbs.com",
    platform: "custom",
    catalogUrl: "https://www.dherbs.com/store/",
  });
  const capture = new DtcAgentProductCapture({
    publication,
    sites: [site],
    sourcePlans: {} as ProductSourcePlans,
    productScope: {
      review: async () => {
        throw new Error("scope should not run");
      },
    },
    routeId: "test",
    egressId: "test",
    agent: {
      capture: async () => ({
        moved: {
          status: "moved" as const,
          requestedUrl,
          actualUrl,
          html: Buffer.from("<main>Full Body Cleanse</main>"),
        },
      }),
    } as unknown as Pick<DtcCaptureAgent, "capture">,
  });
  const result = await capture.capture(
    {
      runId: "11111111-1111-4111-8111-111111111111",
      channel: "dtc",
      url: requestedUrl,
      sourceUrl: "https://www.dherbs.com/store/",
      brandId: "22222222-2222-4222-8222-222222222222",
      sourceId: "33333333-3333-4333-8333-333333333333",
      operationId: "moved-test",
    },
    AbortSignal.timeout(5000),
  );
  expect(result).toMatchObject({
    status: "sighted",
    sighting: {
      reason: "redirected_to_other_product",
      finalUrl: actualUrl,
      archiveKey: expect.any(String),
    },
    movedTo: { url: "https://www.dherbs.com/featured/dherbs-full-body-cleanse", variantId: null },
  });
  const original = JSON.parse(
    Buffer.from(data.get("v3/dtc-html/moved-test/original.json") ?? "").toString(),
  );
  expect(original.fetchedVia.finalUrl).toBe(actualUrl);
  expect(
    [...data.values()].some(
      (bytes) => Buffer.from(bytes).toString() === "<main>Full Body Cleanse</main>",
    ),
  ).toBe(true);
});
