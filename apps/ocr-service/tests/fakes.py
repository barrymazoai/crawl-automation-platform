"""Import the production service without RapidOCR, CUDA, OpenCV or Windows APIs."""
from contextlib import ExitStack, nullcontext
import importlib
import os
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np


def fake_module(name, **members):
    module = ModuleType(name)
    module.__dict__.update(members)
    return module


class FakeHealth:
    identity = "native-birth-1"

    def mark(self, ready):
        pass

    def counts(self):
        return {"healthy_backends": 4, "total_backends": 4}


def load_service(home):
    session = SimpleNamespace(get_providers=lambda: ["CUDAExecutionProvider"], disable_fallback=Mock())
    engine = Mock(return_value=([[[[0, 0], [4, 0], [4, 4], [0, 4]], "Vitamin C", 0.9]], [0.001]))
    engine.text_det = engine.text_rec = SimpleNamespace(session=SimpleNamespace(session=session))
    rapid = fake_module("rapidocr", RapidOCR=Mock(return_value=engine),
                        EngineType=SimpleNamespace(ONNXRUNTIME="onnx"),
                        LangDet=SimpleNamespace(CH="ch", EN="en"), LangRec=SimpleNamespace(CH="ch", EN="en"),
                        ModelType=SimpleNamespace(MOBILE="mobile"),
                        OCRVersion=SimpleNamespace(PPOCRV5="v5", PPOCRV4="v4"))
    modules = {
        "rapidocr": rapid,
        "onnxruntime": fake_module("onnxruntime", get_available_providers=lambda: ["CUDAExecutionProvider"], preload_dlls=Mock()),
        "cv2": fake_module("cv2", setNumThreads=Mock()),
        "backend_health": fake_module("backend_health", BackendHealth=FakeHealth),
    }
    stack = ExitStack()
    stack.enter_context(patch.dict(os.environ, {"OCR_HOME": str(home), "OCR_BACKEND": "cuda", "OCR_INTRA_THREADS": "1"}))
    stack.enter_context(patch.dict(sys.modules, modules))
    sys.modules.pop("ocr_server", None)
    service = importlib.import_module("ocr_server")
    stack.enter_context(patch.object(service, "_decode", return_value=np.zeros((8, 12, 3), dtype=np.uint8)))
    stack.enter_context(patch.object(service, "HardDeadline", side_effect=lambda *_: nullcontext()))
    service.JOB_STORE.identity = lambda _: FakeHealth.identity
    return service, engine, stack, rapid, session
