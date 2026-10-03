import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { sha256 } from "@crawl-automation/platform";
import { captureFile } from "./archive.js";
import { dtcAgentErrors } from "./errors.js";

const Receipt = z.strictObject({
  codec: z.literal("dtc-site-method/1"),
  origin: z.url(),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  // Distinct successful products validate a method; values and Facts are never cached.
  samples: z.array(z.url()).min(1),
});
const key = (url: string) => sha256(Buffer.from(new URL(url).origin));

export async function prepareSiteMethod(input: {
  profileDir: string;
  cwd: string;
  outDir: string;
  skillRoot: string;
  productUrl: string;
  taskSpaceId: number;
  label: string;
  targetId: string;
}) {
  const prior = await savedMethod(input.profileDir, input.productUrl);
  const methodPath = join(input.cwd, "site-method.mjs");
  if (prior) {
    await writeFile(methodPath, prior.source, { flag: "wx" });
    await writeFile(join(input.cwd, "method-cache.json"), JSON.stringify(prior.receipt), {
      flag: "wx",
    });
  }
  const driver = pathToFileURL(join(input.skillRoot, "lib/site-capture.mjs")).href;
  await writeFile(
    join(input.cwd, "run-capture.mjs"),
    `import { prepareBrowserRound } from "./browser-preparation.mjs";\n` +
      `import { runSiteCapture } from ${JSON.stringify(driver)};\n` +
      `await prepareBrowserRound({ taskSpace, listTaskSpaces });\n` +
      `const result = await runSiteCapture(${JSON.stringify({ ...input, methodPath })}, { taskSpace, listTaskSpaces });\n` +
      `console.log(JSON.stringify(result));\n`,
    { flag: "wx" },
  );
}

/** Persist only the actual executed method after its raw material files have been verified and archived. */
export async function retainSiteMethod(input: { profileDir: string; root: string; url: string }) {
  const source = await captureFile(input.root, "site-method.mjs");
  const use = JSON.parse((await captureFile(input.root, "method-use.json")).toString());
  const digest = sha256(source);
  if (use.sha256 !== digest || use.productUrl !== input.url) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE", {
      details: { reason: "site_method_receipt_mismatch" },
    });
  }
  const prior = await savedMethod(input.profileDir, input.url);
  const samples = prior?.receipt.sha256 === digest ? prior.receipt.samples : [];
  const product = new URL(input.url);
  product.search = "";
  const path = `capture-methods/${key(input.url)}/${digest}.mjs`;
  await mkdir(join(input.profileDir, "capture-methods", key(input.url)), { recursive: true });
  // Content-addressed methods are immutable; a revision gets a different file.
  try {
    await writeFile(join(input.profileDir, path), source, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    if (!(await captureFile(input.profileDir, path)).equals(source)) {
      throw error;
    }
  }
  const receipt = Receipt.parse({
    codec: "dtc-site-method/1",
    origin: product.origin,
    path,
    sha256: digest,
    samples: [...new Set([...samples, product.href])],
  });
  const file = join(input.profileDir, `${key(input.url)}.capture.json`);
  await writeFile(`${file}.tmp`, JSON.stringify(receipt));
  await rename(`${file}.tmp`, file);
  return receipt;
}

async function savedMethod(root: string, url: string) {
  let raw: string;
  try {
    raw = await readFile(join(root, `${key(url)}.capture.json`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  const receipt = Receipt.parse(JSON.parse(raw));
  const source = await captureFile(root, receipt.path);
  if (receipt.origin !== new URL(url).origin || sha256(source) !== receipt.sha256) {
    throw dtcAgentErrors.create("DTC.CAPTURE_EVIDENCE", {
      details: { reason: "site_method_identity_mismatch" },
    });
  }
  return { receipt, source };
}
