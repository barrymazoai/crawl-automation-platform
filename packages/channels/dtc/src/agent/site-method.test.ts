import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { retainSiteMethod } from "./site-method.js";

it("does not promote a method whose archived product region duplicates a unique page element", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dtc-duplicate-method-")));
  const profileDir = join(root, "profiles");
  const url = "https://example.com/products/one";
  try {
    await mkdir(join(root, "evidence"));
    await mkdir(profileDir);
    await writeValidatingFiles(root, url);
    await writeFile(
      join(root, "product.html"),
      '<section id="overview">One</section><section id="overview">One</section>',
    );
    expect(await retainSiteMethod({ profileDir, root, url })).toBeNull();
    expect(await readdir(profileDir)).toEqual([]);
    await writeFile(join(root, "product.html"), '<section id="overview">One</section>');
    expect(await retainSiteMethod({ profileDir, root, url })).toMatchObject({
      codec: "dtc-site-method/1",
      samples: [url],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeValidatingFiles(root: string, url: string) {
  const source = Buffer.from("export async function capture() {}\n");
  const sha256 = createHash("sha256").update(source).digest("hex");
  await writeFile(join(root, "site-method.mjs"), source);
  await writeFile(join(root, "method-use.json"), JSON.stringify({ sha256, productUrl: url }));
  await writeFile(
    join(root, "evidence/records.json"),
    JSON.stringify([
      { productUrl: url, fields: { title: "One" }, gallery: [{ url: `${url}/image.webp` }] },
    ]),
  );
  await writeFile(
    join(root, "materials.json"),
    JSON.stringify({
      productHtml: "product.html",
      initialPage: "page.html",
      variants: [],
    }),
  );
  await writeFile(join(root, "capture-notes.json"), "{}");
  await writeFile(join(root, "page.html"), '<main><section id="overview">One</section></main>');
}
