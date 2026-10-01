"""Windows process birth identities and exact-handle termination (no PID-only kill).

Access denied / unverifiable state raises OSError; it is never proof of death.
Kept independent of the OCR engine so the deadline watchdog imports only stdlib.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import os


class ProcessHandle:
    def __init__(self, pid: int, *, terminate: bool = False):
        if os.name != "nt":
            raise OSError("Native OCR process verification requires Windows")
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "OpenProcess": ([wintypes.DWORD, wintypes.BOOL, wintypes.DWORD], wintypes.HANDLE),
            "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
            "WaitForSingleObject": ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
            "GetProcessTimes": ([wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4, wintypes.BOOL),
            "TerminateProcess": ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.kernel, name)
            function.argtypes, function.restype = args, result
        rights = 0x1000 | 0x100000 | (0x0001 if terminate else 0)
        self.handle = self.kernel.OpenProcess(rights, False, pid)
        if not self.handle and ctypes.get_last_error() != 87:  # ERROR_INVALID_PARAMETER: PID absent
            raise ctypes.WinError(ctypes.get_last_error())

    def __enter__(self):
        return self

    def __exit__(self, *_):
        if self.handle:
            self.kernel.CloseHandle(self.handle)

    def identity(self) -> str | None:
        if not self.handle:
            return None
        wait = self.kernel.WaitForSingleObject(self.handle, 0)
        if wait == 0:  # signalled: exited, even if its PID still exists
            return None
        if wait != 258:  # WAIT_TIMEOUT: alive
            raise OSError("Cannot verify process exit state")
        times = [wintypes.FILETIME() for _ in range(4)]
        if not self.kernel.GetProcessTimes(self.handle, *(ctypes.byref(item) for item in times)):
            raise ctypes.WinError(ctypes.get_last_error())
        return str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)

    def stop(self, expected: str) -> None:
        # Holding this handle prevents a PID-reuse race between comparison and kill.
        if self.identity() != expected:
            return
        if not self.kernel.TerminateProcess(self.handle, 124):
            raise ctypes.WinError(ctypes.get_last_error())
        if self.kernel.WaitForSingleObject(self.handle, 5000) != 0:
            raise OSError("Timed-out OCR worker death could not be verified")


def live_identity(pid: int) -> str | None:
    with ProcessHandle(pid) as process:
        return process.identity()
