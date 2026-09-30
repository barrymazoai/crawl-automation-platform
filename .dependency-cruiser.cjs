// Layer boundaries for the restructured Crawler V3 code (docs/architecture/ARCHITECTURE.md).
// A layer imports only layers below it; channels and processing never import each other.
const layer = (name) => `^(apps|packages)/${name}/`;

/** Layers from top to bottom. Each may import only the layers listed after it. */
const order = [
  "api",
  "worker",
  "adapters",
  "app",
  "workflows",
  "channels",
  "processing",
  "platform",
];

// The top layer has nothing above it; an empty `to.path` list would match every module.
const forbidUpward = order.slice(1).map((name, index) => ({
  name: `${name}-imports-downward-only`,
  severity: "error",
  from: { path: layer(name) },
  to: { path: order.slice(0, index + 1).map(layer) },
}));

module.exports = {
  forbidden: [
    ...forbidUpward,
    {
      name: "channels-and-processing-are-separate",
      severity: "error",
      from: { path: layer("channels") },
      to: { path: layer("processing") },
    },
    {
      name: "processing-and-channels-are-separate",
      severity: "error",
      from: { path: layer("processing") },
      to: { path: layer("channels") },
    },
    {
      name: "channel-does-not-import-another-channel",
      severity: "error",
      from: { path: "^packages/channels/([^/]+)/" },
      to: { path: "^packages/channels/([^/]+)/", pathNot: ["^packages/channels/$1/", "^packages/channels/core/"] },
    },
    {
      name: "sql-only-in-platform-and-adapters",
      severity: "error",
      from: { path: layer("(api|app|workflows|channels|processing)"), pathNot: "\\.test\\.ts$" },
      to: { path: "node_modules/(pg|pg-pool)/" },
    },
    {
      name: "temporal-client-only-in-platform-and-adapters",
      severity: "error",
      from: { path: layer("(api|app|channels|processing)"), pathNot: "\\.test\\.ts$" },
      to: { path: "node_modules/@temporalio/(client|worker)/" },
    },
    {
      name: "new-code-does-not-import-archive",
      severity: "error",
      from: { path: layer("(api|worker|adapters|app|workflows|channels|processing|platform)") },
      to: { path: "^archive/" },
    },
    {
      // Only the new version runs: new code never calls the old packages. v3-contracts (data shapes) is kept.
      // Today's imports are listed in .dependency-cruiser-known-violations.json (a dependency-cruiser baseline);
      // only the two versioned resource-gate imports remain for histories predating resource-gate-v1.
      name: "new-code-does-not-import-old-packages",
      severity: "error",
      from: {
        path: [layer("(api|worker|adapters|app|workflows|channels|processing|platform)"), "^ops/deploy/"],
      },
      to: { path: "^packages/v3-", pathNot: "^packages/v3-contracts/" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: { path: layer("(api|worker|adapters|app|workflows|channels|processing|platform)") },
      to: { circular: true },
    },
  ],
  options: {
    // Enumerate kept code; a broad v3-* pattern would include retired implementations (R41).
    includeOnly: {
      path: "^(apps/(api|worker)/|ops/deploy/|packages/(adapters|app|workflows|channels|processing|platform)/|packages/v3-(contracts|vision|artifacts|results|codex|worker-runtime)/src/|packages/v3-product/src/resource-workflow(?:\\.test)?\\.ts$)",
    },
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^archive/|(^|/)(dist|node_modules)/)" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
  },
};
