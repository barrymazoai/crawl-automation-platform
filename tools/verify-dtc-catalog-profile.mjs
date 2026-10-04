// Mini-only direct verification with retained real catalog materials. No browser or model calls.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { retainCatalogProfile, promoteCatalogProfile } from "../crawl-products/lib/catalog-profile.mjs";

const [failedRoot, acceptedRoot, output] = process.argv.slice(2).map(value => resolve(value));
if (!failedRoot || !acceptedRoot || !output) throw new Error("expected_failed_capture_accepted_capture_new_output");
await mkdir(output);
const read = async (root, file) => JSON.parse(await readFile(join(root, file), "utf8"));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const failed = await read(failedRoot, "catalog-method-use.json");
const failedBytes = await readFile(join(failedRoot, "catalog-method-profile.json"));
assert.equal(hash(failedBytes), failed.sha256);
assert.equal(failed.profile, failed.profile.split(/[\\/]/).at(-1));

const profileDir = join(output, "profiles");
await mkdir(profileDir);
const stage = async name => {
  const outDir = join(output, name);
  await mkdir(outDir);
  return retainCatalogProfile(failed.seedUrls, {
    ...failed.listingProfile,
    listingProfile: failed.listingProfile,
    profileDir,
    outDir,
  });
};
await stage("candidate-without-prior");
const active = join(profileDir, failed.profile);
await assert.rejects(stat(active), error => error.code === "ENOENT");
await writeFile(active, failedBytes, { flag: "wx" });
const before = await stat(active);
await stage("candidate-with-prior");
const after = await stat(active);
assert.equal(after.ino, before.ino);
assert.equal(after.mtimeMs, before.mtimeMs);
assert.deepEqual(await readFile(active), failedBytes);

const catalog = await read(acceptedRoot, "catalog.json");
const discovery = await read(acceptedRoot, "catalog-discovery.json");
const accepted = await read(acceptedRoot, "catalog-method-use.json");
assert.equal(catalog.complete, true);
assert.equal(discovery.complete, true);
assert.deepEqual(discovery.method, accepted);
const acceptedBytes = await readFile(join(acceptedRoot, "catalog-method-profile.json"));
assert.equal(hash(acceptedBytes), accepted.sha256);
await promoteCatalogProfile({ profileDir, root: acceptedRoot, sourceUrl: accepted.seedUrls[0] });
assert.deepEqual(await readFile(join(profileDir, accepted.profile)), acceptedBytes);
const proof = {
  at: new Date().toISOString(), failedRoot, acceptedRoot,
  failedMethodSha256: failed.sha256, acceptedMethodSha256: accepted.sha256,
  candidateDoesNotCreatePublicProfile: true, candidatePreservesPriorBytesAndInode: true,
  acceptedPromotionByteExact: true,
  scope: "Real retained methods in an isolated cache; live host acceptance remains a separate check.",
};
await writeFile(join(output, "proof.json"), JSON.stringify(proof, null, 2), { flag: "wx" });
console.log(JSON.stringify(proof));
