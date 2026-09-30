# Independently managed Mini Workers

Each Worker is a separate launchd service with its own PID, log and health file. A separate monitor samples launchd's current PIDs and verifies each Worker's fresh heartbeat, role and configured build. The monitor owns resource health updates, but never starts or stops Workers. Stopping one Worker makes its dependent resources unavailable without terminating other Workers or releasing permits.

Build the controller separately from business releases. Adding files to an existing business release would change its artifact build ID.

```sh
pnpm --filter @crawl-automation/v3-workers check-types
cd apps/v3-workers
node --import tsx scripts/build-independent-deployment.ts
```

The following commands run on Mini. `MANIFEST` is the existing private deployment manifest; `CONTROL` is the deployed `deployment-launchd.js` path. Do not put credentials in command arguments.

```sh
node "$CONTROL" prepare "$MANIFEST"
node "$CONTROL" start "$MANIFEST" all
node "$CONTROL" status "$MANIFEST"
node "$CONTROL" stop "$MANIFEST" amazon-channel-label-text
node "$CONTROL" start "$MANIFEST" amazon-channel-label-text
node "$CONTROL" restart "$MANIFEST" amazon-channel-label-text
node "$CONTROL" stop "$MANIFEST" all
```

For an update, stage the immutable release and its validated runtime configuration, atomically update only that job's entry/runtime references in the manifest, then restart that exact job. The monitor reads updated job bindings without restarting. Changes to deployment membership or resource topology require a monitor configuration update; do not silently change them during a job replacement.

`prepare` validates plists in the deployment's private directory; it does not install or start them. Start installs the specific service in the user's LaunchAgents directory. Stop unloads and disables that service, including across login, and waits for its recorded process to exit. Start enables it again. Services have no automatic crash retry loop. An exited loaded service requires an explicit restart.

## One-time migration from a group supervisor

1. Record current processes and versions. Stage and validate the complete replacement manifest, private configurations and separate controller release. Preserve the original manifest for rollback.
2. Check Temporal's actual pending work and page cleanup. Do not discard evidence or release uncertain permits merely to make deployment appear idle.
3. Gracefully unload the old group supervisor and disable its old LaunchAgent. Verify the supervisor and its owned Workers exited and its lock was removed normally. Do not delete an unverified lock.
4. Activate the prepared manifest and start independent services. For Mini DTC, restore `dtc-control` and `dtc-brand-workflow` first to keep the Windows node's control connection available.
5. Verify actual PIDs, builds, fresh health and resource health. Restart one idle role and prove all other Worker PIDs remain unchanged.

The original `supervisor.lock` remains the mutually exclusive resource-controller lock. A lock from the old supervisor blocks independent startup. The monitor writes `kind: independent-monitor`; no command force-clears stale locks. Historical Windows node recovery and resource quarantine rules remain in force. This controller is macOS-specific; it does not change the Windows node's supervised three-role lifecycle.
