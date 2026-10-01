import asyncio
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from fakes import load_service


class DisconnectTests(unittest.IsolatedAsyncioTestCase):
    async def test_disconnected_request_remains_running_until_engine_returns(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        service, engine, stack, _, _ = load_service(temporary.name)
        self.addCleanup(stack.close)
        entered, finish = threading.Event(), threading.Event()
        original = engine.return_value

        def blocked(_):
            entered.set()
            if not finish.wait(5):
                raise RuntimeError("test deadline")
            return original

        engine.side_effect = blocked
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=service.app), base_url="http://testserver") as client:
            request = asyncio.create_task(client.post("/ocr", files={"file": ("x.png", b"image")},
                                                      headers={"X-OCR-Job-Id": "disconnect"}))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 3))
                request.cancel()
                await asyncio.gather(request, return_exceptions=True)
                body = (await client.get("/jobs/disconnect")).json()
                self.assertEqual(body["state"], "running")
                self.assertIsNone(body["finished_at"])
                self.assertFalse(service.INFERENCE_LOCK.acquire(blocking=False))
            finally:
                finish.set()
            for _ in range(100):
                body = (await client.get("/jobs/disconnect")).json()
                if body["state"] == "done":
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(body["state"], "done")
