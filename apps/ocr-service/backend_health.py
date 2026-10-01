"""Shared ready-process inventory with Windows PID-reuse protection.

Only ready OCR processes registered under this exact supervisor lifetime count.
Stale files are evidence, not health: every GET checks each process's native
creation time and signalled/exited state. No fixed healthy-count or PID-only test.
"""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path

_kernel = ctypes.WinDLL('kernel32', use_last_error=True)
_kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
_kernel.OpenProcess.restype = wintypes.HANDLE
_kernel.CloseHandle.argtypes = [wintypes.HANDLE]
_kernel.CloseHandle.restype = wintypes.BOOL
_kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
_kernel.WaitForSingleObject.restype = wintypes.DWORD
_kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
_kernel.GetProcessTimes.restype = wintypes.BOOL

def live_identity(pid):
    handle = _kernel.OpenProcess(0x1000 | 0x100000, False, pid)
    if not handle:
        return None
    try:
        if _kernel.WaitForSingleObject(handle, 0) != 258:  # WAIT_TIMEOUT = alive
            return None
        times = [wintypes.FILETIME() for _ in range(4)]
        if not _kernel.GetProcessTimes(handle, *(ctypes.byref(t) for t in times)):
            return None
        return (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
    finally:
        _kernel.CloseHandle(handle)

class BackendHealth:
    def __init__(self):
        self.total = int(os.environ.get('OCR_WORKERS', '1'))
        if self.total < 1:
            raise ValueError('OCR_WORKERS must be positive')
        self.pid, self.parent = os.getpid(), os.getppid()
        self.identity, self.parent_identity = live_identity(self.pid), live_identity(self.parent)
        if self.identity is None or self.parent_identity is None:
            raise RuntimeError('Cannot verify OCR process identity')
        self.directory = Path(os.environ.get('OCR_HOME', 'D:/ocr'))/'runtime/backend-health'/f'{self.parent}-{self.parent_identity}'
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory/f'{self.pid}-{self.identity}.json'

    def mark(self, ready):
        record = {'pid':self.pid,'creation_time':self.identity,'parent_pid':self.parent,
                  'parent_creation_time':self.parent_identity,'ready':ready}
        temporary = self.path.with_suffix('.tmp')
        temporary.write_text(json.dumps(record), encoding='utf-8')
        temporary.replace(self.path)

    def counts(self):
        healthy = 0
        if live_identity(self.parent) == self.parent_identity:
            for path in self.directory.glob('*.json'):
                try:
                    record = json.loads(path.read_text(encoding='utf-8'))
                    if (record.get('ready') is True and record.get('parent_pid') == self.parent
                        and record.get('parent_creation_time') == self.parent_identity
                        and live_identity(record['pid']) == record['creation_time']):
                        healthy += 1
                except (OSError, ValueError, KeyError, TypeError):
                    continue  # Incomplete/unverifiable records never count as healthy.
        return {'healthy_backends':healthy,'total_backends':self.total}
