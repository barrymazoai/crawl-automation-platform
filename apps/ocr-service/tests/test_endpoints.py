from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from fakes import load_service


class EndpointTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.service, self.engine, stack, self.rapid, self.session = load_service(temporary.name)
        self.addCleanup(stack.close)
        self.client = self.enterContext(TestClient(self.service.app))

    def post(self, job=None, data=b"image", score="0.3"):
        return self.client.post(f"/ocr?min_score={score}", files={"file": ("image.png", data, "image/png")},
                                headers={} if job is None else {"X-OCR-Job-Id": job})

    def test_production_configuration_and_health_preserved(self):
        body = self.client.get("/health").json()
        self.assertEqual((body["healthy_backends"], body["total_backends"]), (4, 4))
        self.assertEqual(body["session_providers"]["text_det"][0], "CUDAExecutionProvider")
        self.assertEqual((body["intra_op_threads"], body["inter_op_threads"]), (1, 1))
        self.assertEqual(self.session.disable_fallback.call_count, 2)
        params = self.rapid.RapidOCR.call_args.kwargs["params"]
        self.assertTrue(params["Global.model_root_dir"].endswith("models"))
        self.assertTrue(params["EngineConfig.onnxruntime.use_cuda"])

    def test_provider_fallback_is_refused(self):
        self.session.get_providers = lambda: ["CPUExecutionProvider"]
        with self.assertRaisesRegex(RuntimeError, "refusing fallback"):
            self.service._load_engine()

    def test_legacy_request_preserves_response_and_has_deadline(self):
        response = self.post()
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["text"], "Vitamin C")
        self.assertEqual(body["line_count"], 1)
        self.assertEqual(body["image"], {"width": 12, "height": 8, "bytes": 5})
        self.service.HardDeadline.assert_called_once_with(90, self.service.WORKER_PID, self.service.WORKER_BIRTH)
        with self.service.JOB_STORE._connection() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM jobs").fetchone()[0], 0)

    def test_tracked_success_and_duplicate_refused(self):
        self.assertEqual(self.post("job").status_code, 200)
        status = self.client.get("/jobs/job").json()
        self.assertEqual(status["state"], "done")
        self.assertIsNotNone(status["finished_at"])
        self.assertEqual(self.post("job").status_code, 409)
        self.engine.assert_called_once()

    def test_pre_cancel_refuses_late_submission(self):
        self.assertEqual(self.client.get("/jobs/job").json()["state"], "unknown")
        self.assertEqual(self.client.post("/jobs/job/cancel").json()["state"], "cancelled")
        self.assertEqual(self.post("job").status_code, 409)
        self.engine.assert_not_called()

    def test_running_cancel_and_queued_cancel_remain_safe(self):
        entered, finish = threading.Event(), threading.Event()
        result = self.engine.return_value
        def blocked(_):
            entered.set()
            if not finish.wait(5):
                raise RuntimeError("test deadline")
            return result
        self.engine.side_effect = blocked
        with ThreadPoolExecutor(2) as executor:
            request = executor.submit(self.post, "running")
            try:
                self.assertTrue(entered.wait(3))
                receipt = self.client.post("/jobs/running/cancel").json()
                self.assertEqual(receipt["state"], "running")
                self.assertTrue(receipt["cancel_requested"])
                self.assertIsNone(receipt["finished_at"])
                # A queued request can be proven cancelled without waiting for the running engine.
                self.service.JOB_STORE.enqueue("queued", self.service.WORKER_PID, self.service.WORKER_BIRTH)
                self.assertEqual(self.client.post("/jobs/queued/cancel").json()["state"], "cancelled")
            finally:
                finish.set()
            self.assertEqual(request.result().status_code, 409)
        self.assertEqual(self.client.get("/jobs/running").json()["state"], "cancelled")

    def test_inference_failure_is_terminal(self):
        self.engine.side_effect = RuntimeError("GPU error")
        self.assertEqual(self.post("failure").status_code, 500)
        self.assertEqual(self.client.get("/jobs/failure").json()["state"], "failed")

    def test_empty_invalid_and_large_uploads_are_terminal(self):
        self.assertEqual(self.post("empty", b"").status_code, 400)
        self.service._decode.return_value = None
        self.assertEqual(self.post("invalid").status_code, 415)
        self.service.MAX_UPLOAD_BYTES = 2
        self.assertEqual(self.post("large").status_code, 413)
        for job in ("empty", "invalid", "large"):
            self.assertEqual(self.client.get(f"/jobs/{job}").json()["state"], "failed")
        self.engine.assert_not_called()

    def test_invalid_header_path_score_and_methods(self):
        self.assertEqual(self.post("bad id").status_code, 422)
        self.assertEqual(self.client.get("/jobs/bad%20id").status_code, 422)
        self.assertEqual(self.post("bad-score", score="2").status_code, 422)
        self.assertEqual(self.client.get("/ocr").status_code, 405)
        self.assertEqual(self.client.head("/ocr").status_code, 405)
        self.engine.assert_not_called()

    def test_dead_worker_is_reported_failed(self):
        self.service.JOB_STORE.enqueue("dead", 42, "old")
        self.service.JOB_STORE.start("dead", 42, "old")
        self.service.JOB_STORE.identity = lambda _: None
        self.assertEqual(self.client.get("/jobs/dead").json()["state"], "failed")

    def test_final_publication_failure_retires_worker_before_stop_proof(self):
        self.service.JOB_STORE.enqueue("unpublished", self.service.WORKER_PID, self.service.WORKER_BIRTH)
        with patch.object(self.service.JOB_STORE, "finish", side_effect=OSError("disk full")), \
                patch.object(self.service.os, "_exit", side_effect=SystemExit(126)) as exit_worker:
            with self.assertRaises(SystemExit):
                self.service._execute(b"image", 0.3, "request", 0, "unpublished")
        exit_worker.assert_called_once_with(126)
        self.assertEqual(self.service.JOB_STORE.get("unpublished")["state"], "running")
        self.service.JOB_STORE.identity = lambda _: None
        self.assertEqual(self.service.JOB_STORE.get("unpublished")["state"], "failed")

    def test_openapi_matches_checked_in_contract(self):
        contract = Path(__file__).resolve().parents[1] / "openapi.json"
        self.assertEqual(self.service.app.openapi(), json.loads(contract.read_text()))
