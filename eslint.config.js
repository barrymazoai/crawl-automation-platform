// Lint rules for the restructured Crawler V3 code (docs/architecture/CODING_RULES.md).
// Only the new layered packages are governed; older code comes under these rules as it moves.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export const governed = [
  "apps/api/src/**/*.ts",
  "apps/worker/src/**/*.ts",
  "packages/adapters/src/**/*.ts",
  "packages/adapters/integration/**/*.ts",
  "packages/app/src/**/*.ts",
  "packages/workflows/src/**/*.ts",
  "packages/channels/*/src/**/*.ts",
  "packages/processing/src/**/*.ts",
  "packages/platform/src/**/*.ts",
  "ops/deploy/src/**/*.ts",
];

const shortNamesAllowed = ["_", "i", "x", "y"];

export default tseslint.config(
  { ignores: ["archive/**", "**/dist/**", "**/node_modules/**", "**/*.generated.ts"] },
  { files: ["eslint.config.js"], extends: [js.configs.recommended] },
  {
    files: [".dependency-cruiser.cjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: { module: "readonly" } },
  },
  {
    files: ["vitest.v3.config.ts", "packages/v3-product/tsdown.config.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.strict],
  },
  {
    files: governed,
    extends: [js.configs.recommended, ...tseslint.configs.strict],
    rules: {
      "max-lines": ["error", { max: 200, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 40, skipBlankLines: true, skipComments: true }],
      "max-params": ["error", 3],
      "max-statements-per-line": ["error", { max: 1 }],
      "max-depth": ["error", 3],
      complexity: ["error", 10],
      "id-length": ["error", { min: 2, exceptions: shortNamesAllowed, properties: "never" }],
      "no-empty": ["error", { allowEmptyCatch: false }],
      curly: ["error", "all"],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "all" },
      ],
      "no-console": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["../../*/src/*", "../../../*/src/*"], message: "Import packages by name." },
            { group: ["node:http"], message: "Use Hono through apps/api." },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/^\\/Users\\//]",
          message: "No machine paths in code; read them from config.",
        },
        {
          selector: "Literal[value=/^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}/]",
          message: "No IP addresses in code; read them from config.",
        },
        {
          selector: "MemberExpression[object.type='MemberExpression'][object.property.name='message']",
          message: "Do not decide by an error's message text; use its code.",
        },
        {
          selector: "BinaryExpression > MemberExpression[property.name='message']",
          message: "Do not decide by an error's message text; use its code.",
        },
      ],
    },
  },
  {
    files: governed.map((pattern) => pattern.replace("**/*.ts", "**/*.test.ts")),
    rules: { "max-lines-per-function": "off", "max-lines": ["error", 400] },
  },
);
