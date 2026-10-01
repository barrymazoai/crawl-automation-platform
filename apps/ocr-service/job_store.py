"""Local-disk SQLite WAL ledger shared by all uvicorn workers.

Only inference completion or verified process death makes running jobs terminal.
Cancellation and elapsed time alone are never stop proof.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import re
import sqlite3
import time

from process_ownership import live_identity

JOB_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
TERMINAL = ("done", "failed", "cancelled")


class JobConflict(Exception):
    pass


def validate_job_id(job_id: str) -> None:
    if re.fullmatch(JOB_ID_PATTERN, job_id) is None:
        raise ValueError("Invalid OCR job ID")


def _timestamp(value):
    return None if value is None else datetime.fromtimestamp(value, timezone.utc).isoformat()


class JobStore:
    def __init__(self, path: Path, retention_seconds=86400, *, identity=live_identity, clock=time.time):
        if retention_seconds <= 0:
            raise ValueError("Job retention must be positive")
        self.path, self.retention, self.identity, self.clock = path, retention_seconds, identity, clock
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, state TEXT NOT NULL, worker_pid INTEGER, worker_birth TEXT,
                created_at REAL NOT NULL, started_at REAL, finished_at REAL,
                cancel_requested INTEGER NOT NULL DEFAULT 0
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS jobs_finished ON jobs(finished_at)")

    @contextmanager
    def _connection(self):
        db = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA synchronous=FULL")
            yield db
        finally:
            db.close()

    @contextmanager
    def _transaction(self):
        with self._connection() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise

    def enqueue(self, job_id: str, pid: int, birth: str) -> None:
        validate_job_id(job_id)
        with self._transaction() as db:
            try:
                db.execute("INSERT INTO jobs(id,state,worker_pid,worker_birth,created_at) VALUES(?,?,?,?,?)",
                           (job_id, "queued", pid, birth, self.clock()))
            except sqlite3.IntegrityError as error:
                raise JobConflict("Job ID already exists; IDs are never retried") from error

    def start(self, job_id: str, pid: int, birth: str) -> bool:
        with self._transaction() as db:
            return db.execute("""UPDATE jobs SET state='running', started_at=?
                WHERE id=? AND state='queued' AND worker_pid=? AND worker_birth=?""",
                (self.clock(), job_id, pid, birth)).rowcount == 1

    def fail_queued(self, job_id: str, pid: int, birth: str) -> None:
        with self._transaction() as db:
            db.execute("""UPDATE jobs SET state='failed', finished_at=?
                WHERE id=? AND state='queued' AND worker_pid=? AND worker_birth=?""",
                (self.clock(), job_id, pid, birth))

    def finish(self, job_id: str, pid: int, birth: str, *, failed: bool = False) -> dict:
        with self._transaction() as db:
            db.execute("""UPDATE jobs SET state=CASE WHEN ? THEN 'failed'
                WHEN cancel_requested=1 THEN 'cancelled' ELSE 'done' END, finished_at=?
                WHERE id=? AND state='running' AND worker_pid=? AND worker_birth=?""",
                (failed, self.clock(), job_id, pid, birth))
            return self._view(db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())

    def _reconcile(self, db, row):
        if row is not None and row["state"] in ("queued", "running"):
            try:
                identity = self.identity(row["worker_pid"])
            except OSError:
                return row  # Unknown process state must retain the permit.
            if identity != row["worker_birth"]:
                db.execute("UPDATE jobs SET state='failed', finished_at=? WHERE id=?",
                           (self.clock(), row["id"]))
                row = db.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone()
        return row

    def get(self, job_id: str) -> dict:
        validate_job_id(job_id)
        with self._transaction() as db:
            row = self._reconcile(db, db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())
            if row is not None and row["finished_at"] is not None and row["finished_at"] < self.clock() - self.retention:
                db.execute("DELETE FROM jobs WHERE id=?", (job_id,))
                row = None
            return self._view(row)

    def cancel(self, job_id: str) -> dict:
        validate_job_id(job_id)
        with self._transaction() as db:
            now = self.clock()
            row = self._reconcile(db, db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())
            if row is None:
                db.execute("""INSERT INTO jobs(id,state,created_at,finished_at,cancel_requested)
                    VALUES(?,'cancelled',?,?,1)""", (job_id, now, now))
            elif row["state"] == "queued":
                db.execute("UPDATE jobs SET state='cancelled', cancel_requested=1, finished_at=? WHERE id=?", (now, job_id))
            elif row["state"] == "running":
                db.execute("UPDATE jobs SET cancel_requested=1 WHERE id=?", (job_id,))
            return self._view(db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())

    def prune(self) -> None:
        with self._transaction() as db:
            for row in db.execute("SELECT * FROM jobs WHERE state IN ('queued','running')").fetchall():
                self._reconcile(db, row)
            db.execute("DELETE FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?",
                       (self.clock() - self.retention,))

    @staticmethod
    def _view(row) -> dict:
        return {
            "state": "unknown" if row is None else row["state"],
            "worker_pid": None if row is None else row["worker_pid"],
            "started_at": None if row is None else _timestamp(row["started_at"]),
            "finished_at": None if row is None else _timestamp(row["finished_at"]),
            "cancel_requested": False if row is None else bool(row["cancel_requested"]),
        }
