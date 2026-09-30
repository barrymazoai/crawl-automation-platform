import { build } from "tsdown";
import { mkdir, copyFile } from "node:fs/promises";
import { migrationNames } from "../../v3-api/src/bootstrap/schema.js";
const common = { config: false as const, format: "esm" as const, noExternal: [/^@crawl-automation\/v3-/], external: [/^@temporalio\//, "zod", "pg", "@aws-sdk/client-s3", "vitest"] };
await build({ ...common, entry: { "deployment-supervisor": "src/deployment-supervisor.ts", "mini-resource-proof": "scripts/mini-resource-proof.ts", "health-proof-worker": "integration/health-proof-worker.ts" }, outDir: "dist/health-control" });
await build({ ...common, entry: { "dependency-probes.test": "src/dependency-probes.test.ts" }, outDir: "dist/health-control-tests" });
await build({ ...common, entry: { "upgrade-health-control": "scripts/upgrade-health-control.ts", "repair-health-launchagent": "scripts/repair-health-launchagent.ts" }, outDir: "dist/health-control-tools" });
await mkdir(new URL("../dist/health-control/migrations/", import.meta.url), { recursive: true });
for (const name of migrationNames) await copyFile(new URL(`../../../database/v3/${name}`, import.meta.url), new URL(`../dist/health-control/migrations/${name}`, import.meta.url));
