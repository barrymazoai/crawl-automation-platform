import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveWorkspace } from "./archive.js";
import { evidenceFile } from "./evidence-files.js";
import { page, subject } from "./fixtures.test-support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "brand-archive-")));
  roots.push(cwd);
  await mkdir(join(cwd, "pages"));
  const saved = page(subject.brandUrl);
  const { html, archiveKey: _key, ...receipt } = saved;
  await writeFile(join(cwd, receipt.path), html);
  await writeFile(join(cwd, "pages.jsonl"), `${JSON.stringify(receipt)}\n`);
  return { workspace: { cwd, prefix: "brand/fixture", skillPaths: [] }, saved };
}

describe("brand evidence publication", () => {
  it("publishes byte-exact HTML and hash/URL/time manifest through the publication port", async () => {
    const { workspace, saved } = await fixture();
    const publish = vi.fn(async () => undefined);
    const result = await archiveWorkspace({ publish }, workspace, AbortSignal.timeout(3000));
    expect(result.pages[0]).toMatchObject({
      sha256: saved.sha256,
      url: saved.url,
      observedAt: saved.observedAt,
    });
    expect(publish).toHaveBeenCalledWith(
      result.pages[0]?.archiveKey,
      Buffer.from(saved.html),
      "text/html; charset=utf-8",
      expect.any(AbortSignal),
    );
    expect(result.archiveKeys).toContain("brand/fixture/archive.json");
  });
  it("skips an empty record such as a clean run's stderr (R2 refuses a zero-byte read-back)", async () => {
    const { workspace } = await fixture();
    await writeFile(join(workspace.cwd, "stderr.txt"), "");
    const publish = vi.fn(async () => undefined);
    const result = await archiveWorkspace({ publish }, workspace, AbortSignal.timeout(3000));
    expect(publish).not.toHaveBeenCalledWith(
      "brand/fixture/records/stderr.txt",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(result.archiveKeys).not.toContain("brand/fixture/records/stderr.txt");
  });
  it("refuses changed bytes and keeps the original receipt", async () => {
    const { workspace, saved } = await fixture();
    await writeFile(join(workspace.cwd, saved.path), "changed");
    const publish = vi.fn(async () => undefined);
    await expect(
      archiveWorkspace({ publish }, workspace, AbortSignal.timeout(3000)),
    ).rejects.toMatchObject({ code: "BRAND_RESEARCH.EVIDENCE_INVALID" });
    expect(publish).toHaveBeenCalledWith(
      "brand/fixture/records/pages.jsonl",
      expect.any(Buffer),
      "text/plain",
      expect.any(AbortSignal),
    );
  });
  it("refuses traversal and symlinks", async () => {
    const { workspace } = await fixture();
    await symlink(join(workspace.cwd, "pages.jsonl"), join(workspace.cwd, "link"));
    await expect(evidenceFile(workspace.cwd, "../outside")).rejects.toMatchObject({
      code: "BRAND_RESEARCH.EVIDENCE_INVALID",
    });
    await expect(evidenceFile(workspace.cwd, "link")).rejects.toMatchObject({
      code: "BRAND_RESEARCH.EVIDENCE_INVALID",
    });
  });
  it("never reports publication as successful when the port fails", async () => {
    const { workspace } = await fixture();
    const failure = new Error("publication failed");
    await expect(
      archiveWorkspace(
        {
          publish: async () => {
            throw failure;
          },
        },
        workspace,
        AbortSignal.timeout(3000),
      ),
    ).rejects.toBe(failure);
  });
});
