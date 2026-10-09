/** Host-owned mechanical snapshot method: no content extraction or model judgments. */
export function evidenceModule(): string {
  return `import { randomUUID, createHash } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { prepareBrowserRound } from "./browser-preparation.mjs";
export async function openEvidencePage(runtime) {
  const { page, navigate } = await prepareBrowserRound(runtime);
  const savePage = async () => {
    // Recheck exact target and user ownership immediately before taking the snapshot.
    await prepareBrowserRound(runtime);
    const snapshot = await page.evaluate(() => ({
      url: location.href, html: document.documentElement.outerHTML
    }));
    const bytes = Buffer.from(snapshot.html, "utf8");
    const path = "pages/" + randomUUID() + ".html";
    const receipt = { url: snapshot.url, observedAt: new Date().toISOString(), path,
      sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length };
    await writeFile(new URL(path, import.meta.url), bytes, { flag: "wx", mode: 0o600 });
    await appendFile(new URL("pages.jsonl", import.meta.url), JSON.stringify(receipt) + "\\n", { mode: 0o600 });
    return receipt;
  };
  return { page, navigate, savePage };
}
`;
}
