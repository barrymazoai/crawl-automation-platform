import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const scopeKey = url => hash(new URL(url).href);

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function savedScript(profileDir, sourceUrl) {
  const receipt = await optionalJson(join(profileDir, `${scopeKey(sourceUrl)}.catalog-script.json`));
  if (!receipt) return null;
  if (receipt.codec !== "dtc-catalog-script/1" || receipt.sourceUrl !== sourceUrl
    || !/^[a-f0-9]{64}$/.test(receipt.sha256)
    || receipt.path !== `catalog-methods/${scopeKey(sourceUrl)}/${receipt.sha256}.mjs`) {
    throw new Error("catalog_script_cache_identity_mismatch");
  }
  const source = await readFile(join(profileDir, receipt.path));
  if (hash(source) !== receipt.sha256) throw new Error("catalog_script_cache_hash_mismatch");
  return { source, receipt: { ...receipt, state: "verified" } };
}

/** Versioned learned methods are candidates until a real host-verified capture promotes them. */
async function learnedCandidate(skillRoot, sourceUrl) {
  const index = await optionalJson(join(skillRoot, "methods/catalog/index.json"));
  const entry = index?.find(item => item.sourceUrl === sourceUrl);
  if (!entry) return null;
  const directory = resolve(skillRoot, "methods/catalog");
  const path = resolve(directory, entry.path);
  if (!path.startsWith(`${directory}/`) || !path.endsWith(".mjs")) throw new Error("catalog_candidate_path_invalid");
  const source = await readFile(path);
  return { source, receipt: { state: "candidate", sourceUrl, sha256: hash(source),
    path: entry.path, evidence: entry.evidence } };
}

export async function prepareCatalogScript(input) {
  const prior = await savedScript(input.profileDir, input.sourceUrl)
    ?? await learnedCandidate(input.skillRoot, input.sourceUrl);
  const methodPath = join(input.cwd, "catalog-method.mjs");
  if (prior) {
    await writeFile(methodPath, prior.source, { flag: "wx" });
    await writeFile(join(input.cwd, "catalog-script-cache.json"), JSON.stringify(prior.receipt), { flag: "wx" });
  }
  const driver = pathToFileURL(join(input.skillRoot, "lib/catalog-capture.mjs")).href;
  await writeFile(join(input.cwd, "run-capture.mjs"),
    `import { prepareBrowserRound } from "./browser-preparation.mjs";\n`
    + `import { runCatalogCapture } from ${JSON.stringify(driver)};\n`
    + `await prepareBrowserRound({ taskSpace, listTaskSpaces });\n`
    + `console.log(JSON.stringify(await runCatalogCapture(${JSON.stringify({ ...input, methodPath })}, { taskSpace, listTaskSpaces })));\n`,
    { flag: "wx" });
}

/** Only called after the existing host identity, page and completion checks. */
export async function retainCatalogScript({ profileDir, root, sourceUrl }) {
  const use = await optionalJson(join(root, "catalog-script-use.json"));
  if (!use) return; // Historical capture outputs predate the fixed catalog launcher.
  const source = await readFile(join(root, "catalog-method.mjs"));
  if (use.codec !== "dtc-catalog-script-use/1" || use.sourceUrl !== sourceUrl
    || hash(source) !== use.sha256) throw new Error("catalog_script_use_mismatch");
  const path = `catalog-methods/${scopeKey(sourceUrl)}/${use.sha256}.mjs`;
  await mkdir(join(profileDir, "catalog-methods", scopeKey(sourceUrl)), { recursive: true });
  try { await writeFile(join(profileDir, path), source, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST" || !(await readFile(join(profileDir, path))).equals(source)) throw error;
  }
  const receipt = { codec: "dtc-catalog-script/1", sourceUrl, path, sha256: use.sha256 };
  const file = join(profileDir, `${scopeKey(sourceUrl)}.catalog-script.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(receipt), { flag: "wx" });
  await rename(temporary, file);
  return receipt;
}
