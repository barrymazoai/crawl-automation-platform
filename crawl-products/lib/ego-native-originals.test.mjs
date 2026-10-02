import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { retainNativeOriginal } from "./ego-native-originals.mjs";
import { createEgoBrowser } from "./ego-native-browser.mjs";

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "ego-originals-"));
  roots.push(root);
  return root;
}

it("keeps both historical bytes when one URL changes and the working capture is cleared", async () => {
  const root = await workspace();
  const url = "https://shop.test/products/zinc";
  const first = await retainNativeOriginal(root, { url, kind: "html", bytes: "<main>old</main>" });
  const second = await retainNativeOriginal(root, { url, kind: "html", bytes: "<main>new</main>" });
  await mkdir(join(root, "capture"));
  await writeFile(join(root, "capture", "product.html"), "working copy");
  await rm(join(root, "capture"), { recursive: true });
  for (const receipt of [first, second]) {
    const bytes = await readFile(join(root, receipt.path));
    expect(bytes.length).toBe(receipt.byteSize);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.sha256);
  }
  expect(first.path).not.toBe(second.path);
});

it("deduplicates identical bodies but preserves separate capture receipts", async () => {
  const root = await workspace();
  const input = { url: "https://shop.test/image.png", kind: "image", bytes: "original" };
  const first = await retainNativeOriginal(root, input);
  const second = await retainNativeOriginal(root, input);
  expect(second.path).toBe(first.path);
  expect(second.sha256).toBe(first.sha256);
  const files = await readdir(join(root, "native-originals"));
  expect(files.filter(file => file.endsWith(".bin"))).toHaveLength(1);
  expect(files.filter(file => file.endsWith(".receipt.json"))).toHaveLength(2);
});

it("refuses to reuse corrupted originals", async () => {
  const root = await workspace();
  const input = { url: "https://shop.test/image.png", kind: "image", bytes: "original" };
  const receipt = await retainNativeOriginal(root, input);
  await chmod(join(root, receipt.path), 0o600);
  await writeFile(join(root, receipt.path), "corrupt");
  await expect(retainNativeOriginal(root, input)).rejects.toThrow("SOURCE.ORIGINAL_CONFLICT");
});

it("retains native HTML, platform data, image and attempt before returning them", async () => {
  const root = await workspace();
  const url = "https://shop.test/products/zinc";
  const productText = '{"product":{"handle":"zinc","vendor":"Website brand","variants":[{"id":42}]}}';
  const png = Buffer.from([137,80,78,71,13,10,26,10,1]);
  const page = { targetId: "owned", url: async () => url,
    evaluate: vi.fn().mockResolvedValueOnce("<main>Original HTML</main>")
      .mockResolvedValueOnce({ status: 200, ok: true, type: "application/json", text: productText }),
    fetch: async (_url, {saveAs}) => { await writeFile(saveAs, png); return { status: 200 }; },
  };
  const browser = createEgoBrowser({ workDir: root, page, productUrl: url,
    task: { spaceId: 6, tabs: async () => [{ targetId: "owned", openedBy: "agent" }] },
    listTaskSpaces: async () => [{ id: 6, ownership: "agent" }],
  });
  expect(await browser.harvestHooks.fetchPageHtml(url)).toBe("<main>Original HTML</main>");
  expect(await browser.harvestHooks.fetchProductData(url)).toMatchObject({ vendor: "Website brand" });
  expect((await browser.harvestHooks.fetchImage("https://shop.test/image.png")).bytes).toEqual(png);
  await browser.harvestHooks.retainAttempt({ result: { status: "complete" }, records: [{ productUrl: url }] });
  const files = await readdir(join(root, "native-originals"));
  const receipts = await Promise.all(files.filter(f => f.endsWith(".receipt.json")).map(async f => JSON.parse(await readFile(join(root, "native-originals", f)))));
  expect(receipts.map(r => r.kind).sort()).toEqual(["harvest", "html", "image", "json"]);
  const product = receipts.find(r => r.kind === "json");
  expect(await readFile(join(root, product.path), "utf8")).toBe(productText);
});

it("captures the selected rendered state without navigating back to a base URL", async () => {
  const root = await workspace();
  const base = "https://shop.test/products/zinc";
  const selected = base + "?variant=22";
  const page = { targetId: "owned", url: async () => selected, goto: vi.fn(),
    evaluate: vi.fn(async () => '<details open><p>Selected 22, expanded.</p></details>') };
  const browser = createEgoBrowser({ workDir: root, page, productUrl: base,
    task: { spaceId: 6, tabs: async () => [{ targetId: "owned", openedBy: "agent" }] },
    listTaskSpaces: async () => [{ id: 6, ownership: "agent" }],
  });
  const source = await browser.harvestHooks.fetchPageSource(base);
  expect(page.goto).not.toHaveBeenCalled();
  expect(source.url).toBe(selected);
  expect(source.receipt.observation.kind).toBe("rendered-dom");
  expect(source.text).toContain("Selected 22, expanded.");
  await expect(browser.harvestHooks.fetchPageHtml(base + "?variant=12")).rejects.toThrow("SOURCE.PAGE_VARIANT");
  await expect(browser.harvestHooks.fetchPageHtml(base + "-foreign")).rejects.toThrow("SOURCE.PAGE_IDENTITY");
  expect(page.evaluate).toHaveBeenCalledTimes(1);
});

it.each(["foreign-product", "http-error", "non-json"])("retains a %s response before refusing platform mapping", async kind => {
  const root = await workspace(), url = "https://shop.test/products/zinc";
  const text = kind === "non-json" ? "<html>Unavailable</html>" : '{"product":{"handle":"other","variants":[]}}';
  const page = { targetId: "owned", url: async () => url,
    evaluate: vi.fn(async () => ({ status: kind === "http-error" ? 503 : 200, ok: kind !== "http-error",
      url: url + ".json", type: kind === "non-json" ? "text/html" : "application/json", text })) };
  const browser = createEgoBrowser({ workDir: root, page, productUrl: url,
    task: { spaceId: 6, tabs: async () => [{ targetId: "owned", openedBy: "agent" }] },
    listTaskSpaces: async () => [{ id: 6, ownership: "agent" }],
  });
  const result = browser.harvestHooks.fetchProductSource(url);
  if (kind === "non-json") await expect(result).resolves.toBeNull();
  else await expect(result).rejects.toThrow(kind === "http-error" ? "SOURCE.PRODUCT_DATA_HTTP" : "SOURCE.PRODUCT_DATA_IDENTITY");
  const receipts = (await readdir(join(root, "native-originals"))).filter(name => name.endsWith(".receipt.json"));
  expect(receipts).toHaveLength(1);
  const receipt = JSON.parse(await readFile(join(root, "native-originals", receipts[0]), "utf8"));
  expect(await readFile(join(root, receipt.path), "utf8")).toBe(text);
  expect(page.evaluate).toHaveBeenCalledTimes(1);
});
