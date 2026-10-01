# Windows NVIDIA OCR — current setup

Use [README.md](README.md#windows-deployment-ownerintegrator) for the complete deployment, verification and rollback commands. It supersedes the old eight-worker ZIP installation instructions captured with the production files.

- Runtime: `D:\ocr\python\python.exe`; CUDA provider required for both detector and recognizer, fallback disabled.
- Code: `D:\crawlv3-cloud\repo\apps\ocr-service`, obtained exclusively from origin `main` with Git. Never transfer code or scripts by SCP/bundle.
- Data: `D:\ocr` retains models, caches, temporary files, health records and the shared SQLite job database.
- Concurrency: four uvicorn workers, one inference lane per worker; ONNX intra/inter-op and OpenCV threads set to one.
- Listener: `127.0.0.1:8081`, existing LAN forwarding unchanged.
- Start: manually run the checkout's `start-nvidia.cmd`. No boot/login auto-start, scheduled task or Windows service installation.
- Stop: pause intake, drain, stop the exact owned console, then verify its supervisor and worker PIDs are absent. Never kill every Python process.
- Rollback: preserve the old `D:\ocr\service` directory; set `OCR_SERVICE_DIR` to that path in the manual launcher, after stopping the new fleet and disabling client job control.

No new production Python dependency is needed. Keep the installed, working ONNX/CUDA environment. The captured `requirements-common.txt` remains unchanged; do not reinstall floating version ranges for this rollout. Unit tests mock the OCR engine, and the native watchdog test terminates only its disposable test child.

The preserved `verify-service.py` belongs to the earlier eight-worker/ZIP acceptance procedure. Do not use it to accept this four-worker Git deployment. Use the README's job-control checks and unchanged `probe.py` instead.
