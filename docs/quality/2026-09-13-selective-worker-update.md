# Mini independent Worker deployment — completed

The user subsequently authorized stopping the group supervisors and starting each Worker independently. Migration completed on 2026-09-13 at 14:09 UTC. Controller source `24df667` is pushed to `main`. No collection was submitted or resumed.

## Completed

- Unloaded and disabled `com.supplysmart.crawl-worker-gnc`, `com.supplysmart.crawl-control-plane-local`, and `com.crawlv3.amazon-history-batch`. Verified their recorded process trees absent.
- Stopped the obsolete GNC inspection owner after three checks proved its exact target absent and its browser instance matched. Its browser process remains alive; no browser-wide close or resource-ledger release was performed.
- The prior stop instruction had already cancelled the 10-product coordinator, its waiting Brand request, and the last waiting product. No capture result or historical evidence was deleted. The newer pilot Worker service remains running.

## Current services, verified 2026-09-13 14:09 UTC

| Deployment | Monitor PID | Independent services ready | All services owned directly by launchd |
| --- | ---: | ---: | --- |
| Main | 68275 | 90/90 | yes |
| Mini DTC | 69191 | 26/26 | yes |
| Amazon 10-product coordinator | 67816 | 2/2 | yes |

The three old supervisors and their 118 child processes were verified absent before independent startup. Old group LaunchAgents are unloaded and disabled. These 118 services comprise 117 Temporal Workers and one Brand web/API process. Every current Temporal identity was found on its configured task queue. All five resource-health records were healthy and unexpired. Database, Temporal infrastructure, proxy, browser profiles, evidence, Reviews, and the two quarantined resource permits were preserved.

Mini DTC control became ready 7.09 seconds after its group stop began; its node Workflow Worker was ready at 11.55 seconds, and all 26 DTC roles at 29.7 seconds. No Windows stop or redeployment was requested. The Windows node Workflow remained RUNNING and its resource heartbeat remained current.

## Activated updates

- Business artifact source: `89318fe`; the new controller was built separately to avoid changing business artifact build IDs.
- Main manifest: the 67 old release references were replaced; 23 already updated roles retained their business entries/configuration. DTC and the pilot retained their business versions while switching process management.
- The Amazon text, vision and resource roles now contain the previously missing citation Review stop-proof fix. Mini DTC already contained it.
- Replacement release: `/Users/barry/apps/crawlv3-batch-a.UiA4dx/release-selective-89318fe-20260913`.
- Active manifest: `/Users/barry/apps/crawlv3-batch-a.UiA4dx/live/deployment.json`. Its previous version is preserved in the migration evidence directory.
- All 67 replacement role registrations, capabilities, contract versions and build IDs were checked on Mini without starting Workers/providers.
- Generic text and vision compatibility fingerprints changed with the updated implementation. Their runtime configurations and all five referencing legacy GNC policy configurations were aligned using the new providers' metadata. Model settings were preserved.
- Validation: TypeScript passed; 36 Review stop-proof/resource Workflow tests and 10 independent-service tests passed on Mini. Native launchd lifecycle validation passed.
- Temporal read-only inspection found zero RUNNING business Workflows on the main deployment's queues.
- Actual process commands, configured builds, reported builds and artifact hashes matched for all applicable services.

## Single-Worker restart verified

Only `amazon-channel-label-text` was restarted after all deployments were ready: PID `68758` became `70083`. The other **117 service PIDs and all 3 monitor PIDs remained unchanged**. The isolated native test also proved that stopping and restarting a monitor leaves its Workers running. All fixture processes were subsequently stopped.

The monitor reads current job bindings and launchd PIDs, so a later single-Worker replacement needs no monitor restart. It never starts or stops Workers. See [independent Mini operations](../../apps/v3-workers/INDEPENDENT_MINI.md).

Example on Mini:

```sh
/opt/homebrew/bin/node \
  /Users/barry/apps/crawlv3-batch-a.UiA4dx/release-independent-control-20260913/independent-deployment/deployment-launchd.js \
  restart /Users/barry/apps/crawlv3-batch-a.UiA4dx/live/deployment.json \
  amazon-channel-label-text
```

Replace `restart` with `status`, `stop` or `start` as needed. For an update, validate the new immutable artifact/private runtime, atomically update that job's manifest references, then restart the exact job.

Private migration evidence is retained on Mini under `/Users/barry/apps/crawlv3-history-20260913/independent-migration-20260913/`: before/after manifests and process inventories, startup logs, the single-restart proof, Temporal poller/resource verification and final health. The initial audit remains under `/Users/barry/apps/crawlv3-history-20260913/selective-update-20260913/`. No credentials were copied to this report or Git.
