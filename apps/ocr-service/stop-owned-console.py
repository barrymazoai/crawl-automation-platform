"""Send graceful CTRL_BREAK only to a console containing the explicitly allowed OCR PIDs."""
import ctypes
from ctypes import wintypes
import json
import os
import sys
import time

target = int(sys.argv[1])
allowed = {int(p) for p in sys.argv[2:]} | {os.getpid()}
kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.FreeConsole()
if not kernel.AttachConsole(target):
    raise ctypes.WinError(ctypes.get_last_error())
try:
    array = (wintypes.DWORD * 256)()
    count = kernel.GetConsoleProcessList(array, 256)
    if not count or count > 256:
        raise RuntimeError('Could not enumerate console safely')
    members = set(array[:count])
    if not members <= allowed:
        raise RuntimeError('Unapproved console members: '+str(sorted(members-allowed)))
    handler_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.DWORD)
    handler = handler_type(lambda event: True)
    if not kernel.SetConsoleCtrlHandler(handler, True):
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel.GenerateConsoleCtrlEvent(1, 0):
        raise ctypes.WinError(ctypes.get_last_error())
    time.sleep(0.5)
finally:
    kernel.FreeConsole()
print(json.dumps({'target': target, 'verified_console_pids': sorted(members), 'signal': 'CTRL_BREAK'}))
