"""Independent native-inference deadline; no Python thread timeout can stop ONNX.

The watchdog opens the worker's exact Windows process handle before acknowledging
readiness. A single inference lane per worker means it never kills another running
image. Uvicorn's existing multiprocess supervisor replaces a timed-out worker.
"""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import threading
import time

from process_ownership import ProcessHandle


class HardDeadline:
    def __init__(self, seconds: float, pid: int, birth: str):
        self.seconds, self.pid, self.birth = seconds, pid, birth

    def __enter__(self):
        self.process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), str(self.pid), self.birth,
             str(time.monotonic() + self.seconds)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        # Bounded readiness wait; no inference may run without an armed watchdog.
        ready = []
        reader = threading.Thread(target=lambda: ready.append(self.process.stdout.readline()), daemon=True)
        reader.start()
        reader.join(min(5, self.seconds))
        if reader.is_alive() or ready != [b"armed\n"]:
            self._disarm()
            raise RuntimeError("Could not arm OCR request deadline")
        return self

    def _disarm(self):
        try:
            self.process.stdin.write(b".")
            self.process.stdin.flush()
            self.process.stdin.close()
            self.process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            # Do not return a terminal receipt while an armed watchdog is unaccounted for.
            os._exit(125)
        finally:
            self.process.stdout.close()

    def __exit__(self, *_):
        self._disarm()


def watch(pid: int, birth: str, deadline: float):
    with ProcessHandle(pid, terminate=True) as process:
        if process.identity() != birth:
            raise RuntimeError("OCR worker identity does not match")
        finished = threading.Event()

        def completion():
            # EOF means the worker already died; only it holds the write end.
            sys.stdin.buffer.read(1)
            finished.set()

        threading.Thread(target=completion, daemon=True).start()
        print("armed", flush=True)
        if not finished.wait(max(0, deadline - time.monotonic())):
            process.stop(birth)


if __name__ == "__main__":
    watch(int(sys.argv[1]), sys.argv[2], float(sys.argv[3]))
