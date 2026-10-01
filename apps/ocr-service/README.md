# crawlv3 OCR service

The Windows service uses the captured production RapidOCR/ONNX implementation, including actual provider verification, disabled fallback, OpenCV single-thread execution, `OCR_HOME/models`, `BackendHealth`, and lifespan registration. All original `/health` fields used by the Mini probe remain. NVIDIA runs four workers, one engine and one serialized inference lane per worker. Inference runs in a thread so HTTP job controls can answer while native inference runs.

## HTTP contract

- `POST /ocr?min_score=0.3`: one multipart `file`. The optional `X-OCR-Job-Id` header binds this invocation to a durable job before inference. IDs are 1–128 ASCII letters/digits/underscore/hyphen, starting with a letter or digit. Use a fresh UUID for every invocation; never reuse or retry an ID. Duplicate or cancelled IDs return **409** without inference. Invalid IDs return **422**. Without the header, the original OCR response, scoring, error statuses, engine settings and health behavior remain; the hard inference deadline still applies.
- `GET /jobs/{id}`: `{"state":"unknown|queued|running|done|failed|cancelled","worker_pid":123,"started_at":"...+00:00","finished_at":null,"cancel_requested":false}`. PID and timestamps are nullable. Timestamps are UTC. Unknown/expired IDs return **200**, `state: unknown`; this is **not stop proof**.
- `POST /jobs/{id}/cancel`: same response shape. An unseen ID becomes a cancelled tombstone, preventing late submission. A queued ID becomes cancelled immediately and cannot enter inference. A running ID remains `running` with `cancel_requested: true`. This implementation lets the engine finish; only afterward does the job become `cancelled` and the OCR request return 409. An engine error remains `failed`. Repeated cancellation preserves terminal outcomes.
- `GET /health`: preserves `status`, actual `healthy_backends` / `total_backends`, backend/providers, worker PID, session providers, model names and thread settings. Adds `job_control_supported`, `request_timeout_seconds`, `job_retention_seconds`.

Only `done`, `failed`, or `cancelled` from a successful status query proves the exact job stopped. Cancellation acceptance, request abort, elapsed time and a missing record do not. The control endpoints have the same trusted-network access boundary as OCR; retain the loopback listener and existing LAN forwarding.

## Shared state and hard deadline

`OCR_HOME/runtime/jobs.sqlite3` uses Python's built-in SQLite, WAL and `synchronous=FULL`. Short `BEGIN IMMEDIATE` transactions serialize enqueue/start/cancel/finish across all four processes; each operation opens its own connection. This avoids per-worker memory, cross-process Python locks and Windows rename races. Keep this database on local NTFS, shared by every worker behind this endpoint, not on a network share or in the code checkout. There is no new runtime dependency.

Jobs record both PID and native process creation time. Each status query checks nonterminal owners using a Windows process handle. A dead owner or reused PID becomes `failed`; access denied or unverifiable liveness stays nonterminal. Do not delete the database during restarts or deployment. A missing database cannot establish stop proof for earlier jobs.

A separate lightweight Python watchdog opens the exact worker process handle and confirms its creation time before the inference lane starts decoding. It enforces `OCR_REQUEST_TIMEOUT_SECONDS` independently of the worker's event loop, GIL and native ONNX call. On timeout it terminates that worker through the verified handle. The HTTP connection closes; the existing uvicorn multiprocess supervisor replaces the worker. No business operation is retried. Other workers continue. Requests queued in the killed worker also fail, without having entered inference. A later query records failure only after verifying the worker is dead. Ordinary completion disarms and joins the watchdog before publishing a terminal result. Unverifiable deadline teardown or job publication retires the owning worker rather than leaving a live owner attached to an indeterminate running record.

The deadline covers decoding, inference and response construction once that request obtains its worker's inference lane. Multipart upload and time queued for that lane do not constitute running inference; cancellation makes those queued IDs terminal and prevents later start. HTTP disconnect never releases the engine lock or marks still-running work stopped. Model startup is outside the request deadline.

Terminal records and cancellation tombstones expire after `OCR_JOB_RETENTION_SECONDS`, measured from terminal completion. A per-worker periodic sweep (at most 60 seconds apart) reconciles dead owners and removes expired terminal records; GET also expires the requested terminal record. Live or unverifiable owners are never deleted merely due to age. Retention expiry does not authorize reusing an old ID. Keep the retention longer than the entire delayed-delivery and recovery window; after expiry, a query is unknown and requires other retained stop evidence.

| Environment | Default | Meaning |
| --- | --- | --- |
| `OCR_HOME` | `D:\ocr` | Models, job database and existing health inventory |
| `OCR_REQUEST_TIMEOUT_SECONDS` | `90` | Positive finite hard limit per active inference |
| `OCR_JOB_RETENTION_SECONDS` | `86400` | Positive finite terminal-record/tombstone retention |
| `OCR_BACKEND` | `cpu` (`cuda` in NVIDIA launcher) | Required provider; fallback refused |
| `OCR_INTRA_THREADS` | `2` (`1` in NVIDIA launcher) | ONNX intra-op threads; inter-op and OpenCV are 1 |
| `OCR_WORKERS` | `1` (`4` in NVIDIA launcher) | Health expectation; must equal uvicorn `--workers` |
| `OCR_SERVICE_DIR` | launcher's directory | Explicit `--app-dir`; allows rollback to retained production source |

Existing language/model, upload limit, CUDA-device and score environment variables are unchanged. The NVIDIA launcher preserves production OMP/OpenBLAS/MKL/NumExpr single-thread settings and data/cache locations.

## Windows deployment (owner/integrator)

Code reaches Windows **only through Git on `main`**. The integrating agent must first land these files, the generated schema and the client wiring on origin `main`. This task does not commit, push, deploy or restart services. No SCP, copied bundles or copied ops scripts. No scheduled tasks, Windows services, login hooks or boot auto-start.

1. Pause new OCR intake and drain healthy work through the existing owner controls. Save the exact current uvicorn supervisor/worker PIDs, command lines and health response. Inspect the owning OCR console. Stop that console with Ctrl+C; alternatively use `stop-owned-console.py` only with its fully reviewed exact console PID allowlist. Verify the recorded PIDs are absent before switching. Never use a blanket Python/process-name kill. Leave `D:\ocr\service`, models, evidence, environment and runtime database in place for rollback.
2. In PowerShell, update the existing checkout only after the owner has published the integration commit:

   ```powershell
   Set-Location D:\crawlv3-cloud\repo
   git status --short
   git branch --show-current
   # Must be main with no conflicting local edits; stop and review otherwise.
   git pull --ff-only origin main
   git rev-parse HEAD
   # Match this to the owner's approved integration commit.
   & D:\ocr\python\python.exe -m pip freeze > D:\ocr\logs\python-before-job-control.txt
   ```

   There are no new production dependencies; keep the existing working Python/CUDA environment. `requirements-common.txt` is the production snapshot (ranges, not a new lockfile); do not upgrade it during this change. Test-only dependencies are in `requirements-test.txt` and should be installed in an isolated environment if missing.
3. Run the mocked unit suite on Windows (it also includes a real native deadline test against a disposable test child, without CUDA):

   ```powershell
   & D:\ocr\python\python.exe -m unittest discover -s D:\crawlv3-cloud\repo\apps\ocr-service\tests -v
   # Or, when pytest is installed:
   & D:\ocr\python\python.exe -m pytest D:\crawlv3-cloud\repo\apps\ocr-service\tests -q
   ```

4. In a dedicated, manually opened console, start the checked-out launcher:

   ```bat
   set OCR_SERVICE_DIR=D:\crawlv3-cloud\repo\apps\ocr-service
   set OCR_REQUEST_TIMEOUT_SECONDS=90
   set OCR_JOB_RETENTION_SECONDS=86400
   call D:\crawlv3-cloud\repo\apps\ocr-service\start-nvidia.cmd
   ```

   This preserves the production runtime and switches the service command to:

   ```bat
   D:\ocr\python\python.exe -m uvicorn ocr_server:app --app-dir D:\crawlv3-cloud\repo\apps\ocr-service --host 127.0.0.1 --port 8081 --workers 4 --timeout-keep-alive 30 --log-level info
   ```

   Do not run that bare command without the launcher's existing CUDA/thread/cache environment. Starting this console manually is the only service start action. Uvicorn replaces a timed-out child only while this manually started supervisor is alive.
5. In another PowerShell console, verify health, a tracked inference and pre-start cancellation:

   ```powershell
   $base = 'http://127.0.0.1:8081'
   Invoke-RestMethod "$base/health" | ConvertTo-Json -Depth 8
   # Require healthy_backends=4, total_backends=4, cuda, CUDA first for both
   # sessions, intra/inter=1, job_control_supported=true. Observe all 4 worker PIDs.
   $job = [guid]::NewGuid().ToString()
   curl.exe --fail-with-body -H "X-OCR-Job-Id: $job" -F "file=@D:\crawlv3-cloud\repo\apps\ocr-service\samples\label.jpg" "$base/ocr?min_score=0.3"
   Invoke-RestMethod "$base/jobs/$job" | ConvertTo-Json
   # Require done, non-null PID/start/finish, and normal OCR text/lines.
   $cancelled = [guid]::NewGuid().ToString()
   Invoke-RestMethod -Method Post "$base/jobs/$cancelled/cancel" | ConvertTo-Json
   curl.exe -i -H "X-OCR-Job-Id: $cancelled" -F "file=@D:\crawlv3-cloud\repo\apps\ocr-service\samples\label.jpg" "$base/ocr"
   # Require 409, then GET must still say cancelled.
   & D:\ocr\python\python.exe D:\crawlv3-cloud\repo\apps\ocr-service\probe.py --url "$base/ocr?min_score=0.3" --image D:\crawlv3-cloud\repo\apps\ocr-service\samples\label.jpg --parallel 1 4
   ```

   Verify the same endpoint and job controls through the existing Mini route before enabling the client adapter and resuming intake. The old `verify-service.py` is retained byte-for-byte (except LF) as historical production tooling: it expects eight workers and an old ZIP, so it is **not** this rollout's acceptance command. `probe.py` is unchanged.

Rollback: pause intake, let healthy requests finish, stop only the new OCR console, and verify its recorded PIDs are gone. Disable the new client `jobControl` configuration before returning to a provider without this feature. Keep `D:\ocr\runtime\jobs.sqlite3` and the exact stop evidence. In a new manual console, set `OCR_SERVICE_DIR=D:\ocr\service` and call the checkout's `start-nvidia.cmd`; it then uses the retained original production app directory with the same production environment. Verify original health 4/4. Do not erase held permits or claim old correlation IDs are now controllable. To repair the checked-out code, land a follow-up/revert commit on origin `main` and `git pull --ff-only origin main`; do not copy code or switch branches.

## TypeScript integration handoff

New `packages/processing/src/ocr/ocr-job-control.ts` implements the existing `OcrJobControl` port. `OcrApi` already calls `requestHeaders(executionId)` on its `/ocr` transport; no header logic needs to be duplicated. At the existing `new OcrApi(settings, transport)` composition point, enable the adapter only for this fully upgraded endpoint:

```ts
const jobControl = new OcrHttpJobControl({ baseUrl: settings.baseUrl, fetch: transportFetch });
const ocr = new OcrApi(settings, { fetch: transportFetch, jobControl });
```

Omit both `fetch` properties when using global fetch. Export `OcrHttpJobControl` and its options type through the processing package's public index for the worker composition root. Gate this wiring with the deployment configuration/capability check; do not enable it on an old service or a mixed fleet. The same base URL and HTTP transport must serve OCR and controls, including authentication/routing. The new adapter returns `stopped` only for validated terminal status records with a completion time, maps queued/running to `running`, and leaves unknown as `unknown`. It forwards abort signals and never retries OCR.

**Recovery wiring still required:** R59 currently makes at most three immediate queries under a five-second budget in `ocr-api.ts`. A cancelled native call may legitimately take up to 90 seconds to finish. A later bounded recovery pass must re-query the saved exact endpoint/job identity (fresh control signal) and use the existing durable proof path before releasing its permit. Never resubmit OCR, treat 90 elapsed seconds as proof, or reset an exhausted budget into an unbounded loop. If the worker/job controls are unreachable, keep the actionable cleanup failure. This task does not edit `ocr-api.ts`, the existing stop tests, the package index or worker config.

## Tests and schema generation

```sh
python -m pytest apps/ocr-service/tests -q
# Same pytest-collectable unittest cases; useful offline if pytest is absent:
python -m unittest discover -s apps/ocr-service/tests -v
python apps/ocr-service/tests/export_openapi.py
pnpm --filter @crawl-automation/processing generate:ocr-api
```

The tests mock OCR/ONNX/OpenCV/Windows health and exercise cross-process SQLite admission, cancellation races, terminal proof, PID reuse/death, retention, provider fallback refusal, legacy HTTP behavior and watchdog control. Only the native watchdog acceptance requires Windows; it is skipped elsewhere. The OpenAPI export uses the real FastAPI app with these mocks and a temporary database. The existing `openapi-typescript` generator preserves the repository's Blob upload transform. If the `tsx` CLI's IPC socket is sandbox-blocked, run `node --import tsx scripts/generate-ocr-api.ts` from `packages/processing` instead.
