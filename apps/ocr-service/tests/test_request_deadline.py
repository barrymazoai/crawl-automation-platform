import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import request_deadline
from job_store import JobStore


class WatchdogTests(unittest.TestCase):
    def test_expired_deadline_stops_only_verified_handle(self):
        process = Mock()
        process.identity.return_value = "birth"
        blocked = SimpleNamespace(read=lambda _: time.sleep(0.1))
        with patch.object(request_deadline, "ProcessHandle") as handle, \
                patch.object(sys, "stdin", SimpleNamespace(buffer=blocked)), \
                patch.object(sys, "stdout", io.StringIO()):
            handle.return_value.__enter__.return_value = process
            request_deadline.watch(42, "birth", time.monotonic() - 1)
        handle.assert_called_once_with(42, terminate=True)
        process.stop.assert_called_once_with("birth")

    def test_completion_disarms_deadline(self):
        process = Mock()
        process.identity.return_value = "birth"
        with patch.object(request_deadline, "ProcessHandle") as handle, \
                patch.object(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b"."))), \
                patch.object(sys, "stdout", io.StringIO()):
            handle.return_value.__enter__.return_value = process
            request_deadline.watch(42, "birth", time.monotonic() + 10)
        process.stop.assert_not_called()

    def test_wrong_birth_is_never_killed(self):
        process = Mock()
        process.identity.return_value = "reused-pid"
        with patch.object(request_deadline, "ProcessHandle") as handle:
            handle.return_value.__enter__.return_value = process
            with self.assertRaises(RuntimeError):
                request_deadline.watch(42, "birth", time.monotonic() - 1)
        process.stop.assert_not_called()

    def test_parent_arms_and_disarms_on_engine_exception(self):
        child = Mock(stdin=io.BytesIO(), stdout=io.BytesIO(b"armed\n"))
        with patch.object(request_deadline.subprocess, "Popen", return_value=child):
            with self.assertRaisesRegex(RuntimeError, "engine failed"):
                with request_deadline.HardDeadline(90, 42, "birth"):
                    raise RuntimeError("engine failed")
        child.wait.assert_called_once_with(timeout=5)
        self.assertTrue(child.stdin.closed)

    @unittest.skipUnless(os.name == "nt", "Native Windows process termination acceptance")
    def test_native_hard_timeout_kills_owned_worker_and_proves_failure(self):
        with tempfile.TemporaryDirectory() as home:
            database = str(Path(home) / "jobs.sqlite3")
            # No CUDA needed: an unresponsive fake engine in a disposable child.
            code = """
import os, sys, time
from pathlib import Path
from job_store import JobStore
from process_ownership import live_identity
from request_deadline import HardDeadline
pid, birth = os.getpid(), live_identity(os.getpid())
store = JobStore(Path(sys.argv[1]))
store.enqueue('hung', pid, birth)
store.start('hung', pid, birth)
with HardDeadline(1, pid, birth):
    time.sleep(60)
"""
            process = subprocess.Popen([sys.executable, "-c", code, database],
                                       cwd=Path(__file__).resolve().parents[1])
            try:
                self.assertEqual(process.wait(timeout=10), 124)
                self.assertEqual(JobStore(Path(database)).get("hung")["state"], "failed")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
