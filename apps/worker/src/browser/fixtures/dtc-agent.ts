import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DtcCaptureAgent } from "@crawl-automation/channel-dtc";
import { RetainedPublication, sha256 } from "@crawl-automation/platform";
import { vi } from "vitest";

const roots: string[] = [];
export const agentSettings = {
  modelResourceId: "test-model",
  egoSkillPath: "/tmp/not-read-skill/SKILL.md",
  codex: {
    executable: "/tmp/not-executed-codex",
    codexHome: "/tmp/auth",
    workRoot: "/tmp/work",
    runtimeProfileVersion: "test/1",
    timeoutMs: 60000,
    settings: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" },
  },
};
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export async function cleanupCaptures() {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export function mockCapture(
  publication: RetainedPublication,
  input: { url: string; html: string },
) {
  return vi.spyOn(DtcCaptureAgent.prototype, "capture").mockImplementation(async (request) => {
    const image = `${new URL(input.url).origin}/label.jpg`;
    const files = {
      "product.html": input.html,
      "front.png": png,
      "evidence/records.json": JSON.stringify([
        {
          productUrl: input.url,
          fields: { title: "Sleep", brand: "Beta", price: "12.50", currency: "USD" },
          variants: [{ variantId: "11", url: `${input.url}?variant=11` }],
          pageHtml: "product.html",
          gallery: [{ url: image, localPath: "front.png", mime: "image/png" }],
          flags: [],
        },
      ]),
      "capture-review.json": JSON.stringify({
        productUrl: input.url,
        selectedVariantId: "11",
        galleryUrls: [image],
        galleryComplete: true,
        variantsComplete: true,
        detailComplete: true,
        method: "fixture visual review",
        surface: "local_file",
        verifier: "codex",
        evidence: ["front.png"],
        imageAssignments: [{ url: image, variantId: "11", basis: "variant-featured" }],
      }),
    };
    return retainedFixture(publication, { operationId: request.operationId, files });
  });
}

export async function catalogFixture(
  publication: RetainedPublication,
  input: { operationId: string; next: string },
) {
  const origin = new URL(input.next).origin;
  const urls = [`${origin}/collections/alpha`, input.next];
  const pages = urls.map((url, i) => ({
    url,
    htmlPath: `page-${i}.html`,
    screenshotPath: "page.png",
    entries: [
      { url: `${origin}/products/${i ? "rest" : "sleep"}`, title: "Product", brand: "Alpha" },
    ],
  }));
  return retainedFixture(publication, {
    operationId: input.operationId,
    files: {
      "page.png": png,
      "page-0.html": '<main><a href="/products/sleep">Sleep</a></main>',
      "page-1.html": '<main><a href="/products/rest">Rest</a></main>',
      "catalog.json": JSON.stringify({
        pages,
        complete: true,
        termination: {
          exhausted: true,
          reason: "next absent",
          method: "page replay",
          evidence: ["page.png"],
          zeroGrowthRounds: 1,
          oracle: { expected: 2, observed: 2, comparable: true },
        },
      }),
    },
  });
}

async function retainedFixture(
  publication: RetainedPublication,
  input: { operationId: string; files: Record<string, string | Buffer> },
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dtc-capture-fixture-")));
  roots.push(root);
  const prefix = `v3/dtc-agent/${input.operationId}`;
  const files = [];
  for (const [path, content] of Object.entries(input.files)) {
    const bytes = Buffer.from(content);
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), bytes);
    const mediaType = path.endsWith("png")
      ? "image/png"
      : path.endsWith("html")
        ? "text/html"
        : "application/json";
    const objectKey = `${prefix}/${path}`;
    await publication.publish(objectKey, bytes, mediaType, new AbortController().signal);
    files.push({ path, objectKey, mediaType, byteSize: bytes.length, sha256: sha256(bytes) });
  }
  return { root, prefix, files, evidenceFiles: files, manifestKey: `${prefix}/capture.json` };
}
