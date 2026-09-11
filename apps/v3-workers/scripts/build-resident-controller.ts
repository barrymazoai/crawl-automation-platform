import { build } from 'tsdown';
const common={config:false as const,format:'esm' as const,noExternal:[/^@crawl-automation\/v3-/],external:['pg','zod','vitest']};
await build({...common,entry:{'deployment-supervisor':'src/deployment-supervisor.ts'},outDir:'dist/resident-controller'});
await build({...common,entry:{'worker-readiness.test':'src/worker-readiness.test.ts','dependency-probes.test':'src/dependency-probes.test.ts','merge-channel-deployment.test':'src/merge-channel-deployment.test.ts'},outDir:'dist/resident-controller-tests'});
