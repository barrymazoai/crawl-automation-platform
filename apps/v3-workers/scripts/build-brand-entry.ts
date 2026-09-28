import { build } from 'tsdown';
await build({ entry: { cli: 'src/brand-entry/local-cli.ts', importer: 'src/brand-entry/importer.ts', 'browser-script': 'src/brand-entry/browser-script.ts' },
  outDir: 'dist/brand-entry', config: false, format: 'esm', noExternal: [/^@crawl-automation\/v3-/],
  external: ['zod', 'pg'] });
