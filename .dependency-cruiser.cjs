// Layer boundaries for the restructured Crawler V3 code (docs/architecture/ARCHITECTURE.md).
// A layer imports only layers below it; channels and processing never import each other.
const layer = (name) => `^(apps|packages)/${name}/`;

/** Layers from top to bottom. Each may import only the layers listed after it; the CLI uses the API's types. */
const order = [
  "cli",
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
      from: { path: layer("(api|cli|app|workflows|channels|processing)"), pathNot: "\\.test\\.ts$" },
      to: { path: "node_modules/(pg|pg-pool)/" },
    },
    {
      name: "temporal-client-only-in-platform-and-adapters",
      severity: "error",
      from: { path: layer("(api|cli|app|channels|processing)"), pathNot: "\\.test\\.ts$" },
      to: { path: "node_modules/@temporalio/(client|worker)/" },
    },
    {
      name: "new-code-does-not-import-old-apps",
      severity: "error",
      from: { path: layer("(api|cli|worker|adapters|app|workflows|channels|processing|platform)") },
      to: { path: "^apps/(v3-api|v3-workers|backend|web|browser-node)/" },
    },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(dist|node_modules)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
  },
};
