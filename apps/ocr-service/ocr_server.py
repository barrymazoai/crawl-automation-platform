"""
OCR HTTP service compatible with the existing Windows service protocol used by
packages/v3-ocr (MultipartOcr):

    POST /ocr?min_score=0.3   multipart/form-data, field name "file"
    -> 200 application/json {"text": str, "lines": [{"text","score","polygon"}], ...extras}

Engine: RapidOCR (PP-OCRv5 ONNX models) on ONNX Runtime.
Backend is chosen by env OCR_BACKEND = directml | cuda | cpu.
One RapidOCR instance per worker process; run with `uvicorn ... --workers N`.
Nothing is written outside OCR_HOME (logs) and the Python environment.
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
import sys
import time
import threading
import uuid
from pathlib import Path
from typing import Annotated, Any, Literal
from contextlib import asynccontextmanager, suppress
from backend_health import BackendHealth
from job_store import JOB_ID_PATTERN, JobConflict, JobStore
from request_deadline import HardDeadline

import numpy as np
from fastapi import FastAPI, File, Header, Path as ApiPath, Query, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

BACKEND = os.environ.get("OCR_BACKEND", "cpu").lower()
LANG = os.environ.get("OCR_LANG", "en").lower()
OCR_VERSION = os.environ.get("OCR_VERSION", "PP-OCRv5")
DEFAULT_MIN_SCORE = float(os.environ.get("OCR_MIN_SCORE", "0.3"))
MAX_UPLOAD_BYTES = int(os.environ.get("OCR_MAX_UPLOAD_BYTES", str(32 * 1024 * 1024)))
INTRA_THREADS = int(os.environ.get("OCR_INTRA_THREADS", "2"))
REQUEST_TIMEOUT_SECONDS = float(os.environ.get("OCR_REQUEST_TIMEOUT_SECONDS", "90"))
JOB_RETENTION_SECONDS = float(os.environ.get("OCR_JOB_RETENTION_SECONDS", "86400"))
if not 0 < REQUEST_TIMEOUT_SECONDS < float("inf") or not 0 < JOB_RETENTION_SECONDS < float("inf"):
    raise ValueError("OCR request timeout and job retention must be finite and positive")
DETECTOR_NAME = f"ch_{OCR_VERSION}_det_mobile"
RECOGNIZER_NAME = f"{LANG}_{OCR_VERSION}_rec_mobile"

log = logging.getLogger("ocr")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(process)d %(levelname)s %(message)s")


def _preload_cuda_dlls() -> None:
    """onnxruntime>=1.21 can load CUDA/cuDNN DLLs installed via pip (nvidia-* packages)."""
    try:
        import onnxruntime as ort  # noqa: WPS433
        preload = getattr(ort, "preload_dlls", None)
        if preload:
            preload()
    except Exception as error:  # pragma: no cover - environment specific
        log.warning("preload_dlls failed: %s", error)


def _build_params() -> dict[str, Any]:
    """RapidOCR 3.x `params` keys. If your installed rapidocr rejects a key,
    compare with `python -c "import rapidocr, os; print(os.path.dirname(rapidocr.__file__))"`/config.yaml."""
    from rapidocr import EngineType, LangDet, LangRec, ModelType, OCRVersion

    version = {"PP-OCRv5": OCRVersion.PPOCRV5, "PP-OCRv4": OCRVersion.PPOCRV4}[OCR_VERSION]
    rec_lang = {"en": LangRec.EN, "ch": LangRec.CH}[LANG]
    # PP-OCRv5's published shared detector supports English; no en/v5 detector exists.
    det_lang = LangDet.CH if OCR_VERSION == "PP-OCRv5" else {"en": LangDet.EN, "ch": LangDet.CH}[LANG]
    params: dict[str, Any] = {
        "Global.text_score": 0.0,  # filtering happens per request via min_score
        # Lines printed sideways are turned 90 degrees one fixed way before recognition; the 0/180 line classifier
        # flips the ones that end up upside down (a sideways Facts panel read as "%33333", owner 2026-10-07).
        "Global.use_cls": True,
        "Global.model_root_dir": os.path.join(os.environ.get("OCR_HOME", "D:\\ocr"), "models"),
        "Det.engine_type": EngineType.ONNXRUNTIME,
        "Det.lang_type": det_lang,
        "Det.model_type": ModelType.MOBILE,
        "Det.ocr_version": version,
        "Rec.engine_type": EngineType.ONNXRUNTIME,
        "Rec.lang_type": rec_lang,
        "Rec.model_type": ModelType.MOBILE,
        "Rec.ocr_version": version,
        "EngineConfig.onnxruntime.intra_op_num_threads": INTRA_THREADS,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        "EngineConfig.onnxruntime.use_cuda": BACKEND == "cuda",
        "EngineConfig.onnxruntime.use_dml": BACKEND == "directml",
    }
    if BACKEND == "cuda":
        params["EngineConfig.onnxruntime.cuda_ep_cfg.device_id"] = int(os.environ.get("OCR_CUDA_DEVICE", "0"))
    return params


def _load_engine():
    if BACKEND == "cuda":
        _preload_cuda_dlls()
    import onnxruntime as ort
    from rapidocr import RapidOCR

    providers = ort.get_available_providers()
    wanted = {"directml": "DmlExecutionProvider", "cuda": "CUDAExecutionProvider", "cpu": "CPUExecutionProvider"}[BACKEND]
    if wanted not in providers:
        log.error("backend %s requested but provider %s not available; providers=%s", BACKEND, wanted, providers)
        sys.exit(2)
    engine = RapidOCR(params=_build_params())
    actual = {}
    for name in ("text_det", "text_rec"):
        session = getattr(engine, name).session.session
        actual[name] = session.get_providers()
        if actual[name][0] != wanted:
            raise RuntimeError(f"{name}: requested {wanted}, got {actual[name]}; refusing fallback")
        session.disable_fallback()
    import cv2
    cv2.setNumThreads(1)
    engine._verified_providers = actual
    log.info("engine ready backend=%s providers=%s det=%s rec=%s", BACKEND, providers, DETECTOR_NAME, RECOGNIZER_NAME)
    return engine, providers


ENGINE, PROVIDERS = _load_engine()
BACKEND_HEALTH = BackendHealth()
WORKER_PID, WORKER_BIRTH = os.getpid(), str(BACKEND_HEALTH.identity)
JOB_STORE = JobStore(Path(os.environ.get("OCR_HOME", "D:/ocr")) / "runtime/jobs.sqlite3", JOB_RETENTION_SECONDS)
INFERENCE_LOCK = threading.Lock()


async def _prune_jobs():
    while True:
        try:
            await run_in_threadpool(JOB_STORE.prune)
        except Exception:
            log.exception("OCR job retention sweep failed")
        await asyncio.sleep(min(60, JOB_RETENTION_SECONDS))

@asynccontextmanager
async def lifespan(app):
    BACKEND_HEALTH.mark(True)
    pruning = asyncio.create_task(_prune_jobs())
    try:
        yield
    finally:
        pruning.cancel()
        with suppress(asyncio.CancelledError):
            await pruning
        BACKEND_HEALTH.mark(False)

app = FastAPI(title="crawlv3-ocr", docs_url=None, redoc_url=None, lifespan=lifespan)


def _decode(data: bytes) -> np.ndarray | None:
    import cv2

    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        try:  # webp/heic fallbacks via Pillow when OpenCV cannot decode
            from PIL import Image

            img = cv2.cvtColor(np.array(Image.open(io.BytesIO(data)).convert("RGB")), cv2.COLOR_RGB2BGR)
        except Exception:
            return None
    return img


def _normalize(result: Any) -> tuple[list[dict[str, Any]], float]:
    """Accept RapidOCR 3.x output objects and 2.x (list, elapse) tuples."""
    lines: list[dict[str, Any]] = []
    predict_ms = 0.0
    if isinstance(result, tuple) and len(result) == 2:  # rapidocr 2.x
        items, elapse = result
        for item in items or []:
            box, text, score = item[0], item[1], float(item[2])
            lines.append({"text": str(text), "score": score, "polygon": [[int(round(x)), int(round(y))] for x, y in box]})
        try:
            predict_ms = float(sum(e for e in elapse if e)) * 1000
        except Exception:
            predict_ms = 0.0
        return lines, predict_ms
    boxes = getattr(result, "boxes", None)
    txts = getattr(result, "txts", None) or ()
    scores = getattr(result, "scores", None) or ()
    if boxes is not None:
        for box, text, score in zip(boxes, txts, scores):
            lines.append({"text": str(text), "score": float(score), "polygon": [[int(round(float(x))), int(round(float(y)))] for x, y in box]})
    elapse = getattr(result, "elapse", None)
    try:
        if isinstance(elapse, dict):
            predict_ms = float(sum(v for v in elapse.values() if v)) * 1000
        elif elapse is not None:
            predict_ms = float(sum(e for e in elapse if e)) * 1000
    except Exception:
        predict_ms = 0.0
    return lines, predict_ms


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": "ok", **BACKEND_HEALTH.counts(), "backend": BACKEND, "providers": PROVIDERS, "worker_pid": os.getpid(),
            "detector": DETECTOR_NAME, "recognizer": RECOGNIZER_NAME, "default_min_score": DEFAULT_MIN_SCORE,
            "session_providers": ENGINE._verified_providers,
            "intra_op_threads": INTRA_THREADS, "inter_op_threads": 1,
            "job_control_supported": True, "request_timeout_seconds": REQUEST_TIMEOUT_SECONDS,
            "job_retention_seconds": JOB_RETENTION_SECONDS}


class JobStatus(BaseModel):
    state: Literal["unknown", "queued", "running", "done", "failed", "cancelled"]
    worker_pid: int | None
    started_at: str | None
    finished_at: str | None
    cancel_requested: bool


JobId = Annotated[str, ApiPath(pattern=JOB_ID_PATTERN, max_length=128)]


@app.get("/jobs/{job_id}", response_model=JobStatus)
def job_status(job_id: JobId):
    return JOB_STORE.get(job_id)


@app.post("/jobs/{job_id}/cancel", response_model=JobStatus)
def cancel_job(job_id: JobId):
    return JOB_STORE.cancel(job_id)


@app.post("/ocr", responses={409: {"description": "Job ID already used or cancelled"}})
async def ocr(request: Request, file: UploadFile = File(...),
              min_score: float = Query(DEFAULT_MIN_SCORE, ge=0.0, le=1.0),
              job_id: Annotated[str | None, Header(alias="X-OCR-Job-Id", pattern=JOB_ID_PATTERN, max_length=128)] = None):
    request_id = uuid.uuid4().hex[:12]
    t0 = time.perf_counter()
    if job_id is not None:
        try:
            JOB_STORE.enqueue(job_id, WORKER_PID, WORKER_BIRTH)
        except JobConflict as error:
            return JSONResponse({"error": str(error), "request_id": request_id}, status_code=409)
    try:
        data = await file.read()
    except BaseException:
        if job_id is not None:
            JOB_STORE.fail_queued(job_id, WORKER_PID, WORKER_BIRTH)
        raise
    # A thread keeps status/cancel responsive during native inference. The lock
    # belongs to the executing thread, so HTTP disconnect/cancellation cannot
    # unlock the engine or manufacture a terminal receipt while it still runs.
    return await run_in_threadpool(_execute, data, min_score, request_id, t0, job_id)


def _execute(data, min_score, request_id, t0, job_id):
    with INFERENCE_LOCK:
        if job_id is not None:
            try:
                started = JOB_STORE.start(job_id, WORKER_PID, WORKER_BIRTH)
            except Exception:
                log.exception("Cannot verify job start publication; retiring this OCR worker")
                os._exit(126)
            if not started:
                return JSONResponse({"error": "job cancelled or already used", "request_id": request_id}, status_code=409)
        failed = True
        try:
            with HardDeadline(REQUEST_TIMEOUT_SECONDS, WORKER_PID, WORKER_BIRTH):
                response = _infer(data, min_score, request_id, t0)
            failed = response.status_code != 200
        finally:
            # Runs only after inference returned/raised AND its watchdog disarmed.
            # A hard timeout exits the process; a later query must verify death.
            if job_id is not None:
                try:
                    status = JOB_STORE.finish(job_id, WORKER_PID, WORKER_BIRTH, failed=failed)
                except Exception:
                    log.exception("Cannot publish job completion; retiring this OCR worker")
                    os._exit(126)
        if job_id is not None and status["state"] == "cancelled":
            return JSONResponse({"error": "job cancelled", "request_id": request_id}, status_code=409)
        return response


def _infer(data, min_score, request_id, t0):
    if not data:
        return JSONResponse({"error": "empty upload", "request_id": request_id}, status_code=400)
    if len(data) > MAX_UPLOAD_BYTES:
        return JSONResponse({"error": "upload too large", "request_id": request_id}, status_code=413)
    img = _decode(data)
    if img is None:
        return JSONResponse({"error": "undecodable image", "request_id": request_id}, status_code=415)
    t1 = time.perf_counter()
    try:
        result = ENGINE(img)
    except Exception as error:
        log.exception("ocr failed request_id=%s", request_id)
        return JSONResponse({"error": "ocr failed", "detail": str(error)[:300], "request_id": request_id}, status_code=500)
    t2 = time.perf_counter()
    lines, predict_ms = _normalize(result)
    kept = [line for line in lines if line["score"] >= min_score]
    text = "\n".join(line["text"] for line in kept)
    t3 = time.perf_counter()
    body = {
        "text": text,
        "lines": kept,
        "line_count": len(kept),
        "detector": DETECTOR_NAME,
        "recognizer": RECOGNIZER_NAME,
        "backend": BACKEND,
        "elapsed_ms": round((t3 - t0) * 1000, 1),
        "decode_ms": round((t1 - t0) * 1000, 1),
        "predict_ms": round(predict_ms or (t2 - t1) * 1000, 1),
        "postprocess_ms": round((t3 - t2) * 1000, 1),
        "queue_wait_ms": 0.0,
        "min_score": min_score,
        "image": {"width": int(img.shape[1]), "height": int(img.shape[0]), "bytes": len(data)},
        "request_id": request_id,
        "worker_pid": os.getpid(),
    }
    return JSONResponse(body)


if __name__ == "__main__":  # manual single-process run for debugging
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("OCR_PORT", "8081")))
