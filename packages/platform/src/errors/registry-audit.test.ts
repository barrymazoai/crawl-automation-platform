import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { unregisteredLiterals } from "../testing/registry-audit.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const folders = [
  "apps/api",
  "apps/worker",
  "packages/app",
  "packages/adapters",
  "packages/workflows",
  "packages/channels",
  "packages/processing",
  "packages/platform",
  "ops/deploy",
];

// R34 second pass: these exact areas are concurrently owned by other agents.
const secondPass =
  /^(packages\/app\/src\/(queue|brand-scans)\/|packages\/adapters\/src\/(migrations\/|postgres\/([^/]*queue[^/]*|delivery-scan))|packages\/channels\/amazon\/|packages\/channels\/core\/src\/adapter\.ts$|packages\/channels\/wholefoods\/src\/whole-foods-adapter\.ts$|apps\/worker\/src\/browser\/|apps\/api\/src\/(queue-parts\.ts|routers\/queue[^/]*|brand-scan-parts\.ts|brand-scan-config\.ts))/;

function productionFiles(): string[] {
  return folders.flatMap((folder) =>
    ts.sys.readDirectory(
      join(root, folder),
      [".ts"],
      ["**/node_modules/**", "**/dist/**", "**/*.test.ts", "**/testing/**", "**/*.generated.ts"],
    ),
  );
}

describe("error code registry audit", () => {
  it("registers every emitted code in the R34 scope", () => {
    const files = productionFiles();
    const config = ts.readConfigFile(join(root, "tsconfig.base.json"), ts.sys.readFile);
    const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const program = ts.createProgram(files, options);
    const audited = files.filter((file) => !secondPass.test(relative(root, file)));
    expect(unregisteredLiterals(program, audited)).toEqual([]);
  });

  it("rejects unknown codes in throw, create, code and causeCode, including templates", async () => {
    const folder = await mkdtemp(join(tmpdir(), "registry-audit-"));
    const file = join(folder, "input.ts");
    await writeFile(
      file,
      `
      const defineErrors = <T>(codes: T) => ({ codes });
      const registered = "TEST.COMPUTED";
      const direct = defineErrors({ "TEST.KNOWN": {}, [registered]: {} });
      const dynamic = defineErrors({} as Record<\`TEST.MAPPED_\${"ONE" | "TWO"}\`, {}>);
      const valid = ["TEST.KNOWN", "TEST.COMPUTED", "TEST.MAPPED_ONE", "TEST.MAPPED_TWO"];
      throw new Error("TEST.THROWN");
      errors.create("TEST.CREATED");
      const result = { code: "TEST.FIELD", causeCode: \`TEST.CAUSE\` };
      // "TEST.COMMENT" is not executable code.
    `,
    );
    const program = ts.createProgram([file], { target: ts.ScriptTarget.ESNext });
    expect(unregisteredLiterals(program, [file]).map((item) => item.code)).toEqual([
      "TEST.THROWN",
      "TEST.CREATED",
      "TEST.FIELD",
      "TEST.CAUSE",
    ]);
  });
});
