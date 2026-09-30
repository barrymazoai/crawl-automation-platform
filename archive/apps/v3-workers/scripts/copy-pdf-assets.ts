import { mkdir, copyFile } from "node:fs/promises";
const target = new URL("../dist/pdf-assets/", import.meta.url);
await mkdir(new URL("python/", target), { recursive: true });
for (const name of ["policy.json", "python/worker.py"]) {
  await copyFile(new URL(`../../../packages/v3-pdf/${name}`, import.meta.url), new URL(name, target));
}
