"""pytest collects unittest cases too; stdlib runner also works in offline environments."""
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
import multiprocessing
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from job_store import JobConflict, JobStore


def competing_process(path):
    store = JobStore(Path(path), identity=lambda _: "birth")
    try:
        store.enqueue("shared", 42, "birth")
        return True
    except JobConflict:
        return False


class JobStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1000.0
        self.live = "birth"
        self.path = Path(self.temp.name) / "runtime/jobs.sqlite3"
        self.store = JobStore(self.path, 100, identity=lambda _: self.live, clock=lambda: self.now)

    def start(self):
        self.store.enqueue("job", 42, "birth")
        self.assertTrue(self.store.start("job", 42, "birth"))

    def test_unknown_is_not_terminal(self):
        self.assertEqual(self.store.get("missing"), dict(state="unknown", worker_pid=None,
            started_at=None, finished_at=None, cancel_requested=False))

    def test_lifecycle_across_connections(self):
        self.start()
        other = JobStore(self.path, identity=lambda _: self.live, clock=lambda: self.now)
        self.assertEqual(other.get("job")["state"], "running")
        self.now += 2
        self.assertEqual(other.finish("job", 42, "birth")["state"], "done")
        status = self.store.get("job")
        self.assertIsNotNone(status["started_at"])
        self.assertIsNotNone(status["finished_at"])

    def test_cancel_before_submission_refuses_late_request(self):
        self.assertEqual(self.store.cancel("job")["state"], "cancelled")
        with self.assertRaises(JobConflict):
            self.store.enqueue("job", 42, "birth")

    def test_cancel_queued_prevents_start(self):
        self.store.enqueue("job", 42, "birth")
        self.assertEqual(self.store.cancel("job")["state"], "cancelled")
        self.assertFalse(self.store.start("job", 42, "birth"))

    def test_cancel_running_requires_actual_finish(self):
        self.start()
        status = self.store.cancel("job")
        self.assertEqual(status["state"], "running")
        self.assertTrue(status["cancel_requested"])
        self.assertIsNone(status["finished_at"])
        self.assertEqual(self.store.finish("job", 42, "birth")["state"], "cancelled")

    def test_failure_and_duplicate_never_retry(self):
        self.start()
        self.assertEqual(self.store.finish("job", 42, "birth", failed=True)["state"], "failed")
        with self.assertRaises(JobConflict):
            self.store.enqueue("job", 42, "birth")
        self.assertFalse(self.store.start("job", 42, "birth"))

    def test_process_death_and_pid_reuse_are_failed(self):
        for identity in (None, "new-birth"):
            with self.subTest(identity=identity):
                job = str(identity)
                self.store.enqueue(job, 42, "birth")
                self.store.start(job, 42, "birth")
                self.live = identity
                self.assertEqual(self.store.get(job)["state"], "failed")

    def test_permission_error_does_not_prove_death(self):
        self.start()
        def inaccessible(_):
            raise PermissionError("access denied")
        self.store.identity = inaccessible
        self.now += 1000
        self.store.prune()
        self.assertEqual(self.store.get("job")["state"], "running")

    def test_only_exact_owner_can_finish(self):
        self.start()
        for pid, birth in ((43, "birth"), (42, "other")):
            self.assertEqual(self.store.finish("job", pid, birth)["state"], "running")

    def test_expiry_never_removes_active_execution(self):
        self.start()
        self.store.cancel("unstarted")
        self.now += 101
        self.store.prune()
        self.assertEqual(self.store.get("unstarted")["state"], "unknown")
        self.assertEqual(self.store.get("job")["state"], "running")
        self.store.finish("job", 42, "birth")
        self.now += 101
        self.assertEqual(self.store.get("job")["state"], "unknown")

    def test_cancel_does_not_rewrite_terminal_outcomes(self):
        self.start()
        self.store.finish("job", 42, "birth")
        self.assertEqual(self.store.cancel("job")["state"], "done")

    def test_cancel_start_race_never_reports_false_stop(self):
        for index in range(20):
            job = f"race-{index}"
            self.store.enqueue(job, 42, "birth")
            barrier = threading.Barrier(2)
            def start():
                barrier.wait()
                return self.store.start(job, 42, "birth")
            def cancel():
                barrier.wait()
                return self.store.cancel(job)
            with ThreadPoolExecutor(2) as executor:
                started, cancelled = executor.submit(start), executor.submit(cancel)
                self.assertEqual(cancelled.result()["state"], "running" if started.result() else "cancelled")

    def test_separate_processes_admit_exactly_once(self):
        with ProcessPoolExecutor(4, mp_context=multiprocessing.get_context("spawn")) as executor:
            self.assertEqual(sum(executor.map(competing_process, [str(self.path)] * 8)), 1)

    def test_invalid_ids_and_retention(self):
        for job in ("", "../x", "a/b", "a\n", "x" * 129):
            with self.assertRaises(ValueError):
                self.store.cancel(job)
        with self.assertRaises(ValueError):
            JobStore(self.path, 0)
