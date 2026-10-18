@echo off
setlocal
REM Manual-only OCR start. Code runs from this git checkout; data stays under D:\ocr.
if not defined OCR_SERVICE_DIR set "OCR_SERVICE_DIR=%~dp0."
set OCR_HOME=D:\ocr
set OCR_BACKEND=cuda
set OCR_CUDA_DEVICE=0
set OCR_LANG=en
set OCR_VERSION=PP-OCRv5
set OCR_MIN_SCORE=0.3
set OCR_INTRA_THREADS=1
set OCR_WORKERS=4
set OCR_PORT=8081
REM Listen on the LAN directly; no netsh portproxy / IP Helper (owner 2026-10-18). The firewall admits the local subnet only.
set OCR_HOST=0.0.0.0
if not defined OCR_REQUEST_TIMEOUT_SECONDS set OCR_REQUEST_TIMEOUT_SECONDS=90
if not defined OCR_JOB_RETENTION_SECONDS set OCR_JOB_RETENTION_SECONDS=86400
set OMP_NUM_THREADS=1
set OPENBLAS_NUM_THREADS=1
set MKL_NUM_THREADS=1
set NUMEXPR_NUM_THREADS=1
set PYTHONNOUSERSITE=1
set PYTHONUNBUFFERED=1
REM keep caches off C:
set PIP_CACHE_DIR=%OCR_HOME%\pip-cache
set TEMP=%OCR_HOME%\tmp
set TMP=%OCR_HOME%\tmp
set CUDA_MODULE_LOADING=LAZY
if not exist "%TEMP%" mkdir "%TEMP%"
if not exist "%OCR_HOME%\logs" mkdir "%OCR_HOME%\logs"
cd /d "%OCR_SERVICE_DIR%"
echo starting OCR backend=%OCR_BACKEND% workers=%OCR_WORKERS% port=%OCR_PORT%
"%OCR_HOME%\python\python.exe" -m uvicorn ocr_server:app --app-dir "%OCR_SERVICE_DIR%" --host %OCR_HOST% --port %OCR_PORT% --workers %OCR_WORKERS% --timeout-keep-alive 30 --log-level info
