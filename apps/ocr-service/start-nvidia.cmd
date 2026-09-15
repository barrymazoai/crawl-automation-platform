@echo off
REM OCR service, NVIDIA GPU via CUDA. Everything lives under D:\ocr.
set OCR_HOME=D:\ocr
set OCR_BACKEND=cuda
set OCR_CUDA_DEVICE=0
set OCR_LANG=en
set OCR_VERSION=PP-OCRv5
set OCR_MIN_SCORE=0.3
set OCR_INTRA_THREADS=1
set OCR_WORKERS=8
set OCR_PORT=8081
REM keep caches off C:
set PIP_CACHE_DIR=%OCR_HOME%\pip-cache
set TEMP=%OCR_HOME%\tmp
set TMP=%OCR_HOME%\tmp
set CUDA_MODULE_LOADING=LAZY
if not exist "%TEMP%" mkdir "%TEMP%"
if not exist "%OCR_HOME%\logs" mkdir "%OCR_HOME%\logs"
cd /d "%OCR_HOME%\service"
call "%OCR_HOME%\venv\Scripts\activate.bat"
echo starting OCR backend=%OCR_BACKEND% workers=%OCR_WORKERS% port=%OCR_PORT%
uvicorn ocr_server:app --host 0.0.0.0 --port %OCR_PORT% --workers %OCR_WORKERS% --timeout-keep-alive 30 --log-level info >> "%OCR_HOME%\logs\ocr-service.log" 2>&1
