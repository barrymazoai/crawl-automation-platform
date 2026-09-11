"""Only subprocess lifecycle tests use this fake, never PDF correctness tests."""
import json
import os
import signal
import sys
import time

mode = sys.argv[1]
if mode == "hang":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    print("ready", file=sys.stderr, flush=True)
    while True:
        time.sleep(0.1)
elif mode == "stdout":
    print("x" * 70000, flush=True)
elif mode == "stderr":
    print("x" * 70000, file=sys.stderr, flush=True)
elif mode == "bad":
    print("not json", flush=True)
elif mode == "extra":
    print(json.dumps({"protocolVersion": 1, "status": "completed", "extra": True}))
elif mode == "crash":
    os.kill(os.getpid(), signal.SIGKILL)
elif mode == "after-complete":
    import runpy
    runpy.run_path(sys.argv[2], run_name="__main__")
    os.kill(os.getpid(), signal.SIGKILL)
elif mode == "secret":
    assert "CLOUDFLARE_R2_SECRET_ACCESS_KEY" not in os.environ
    print(json.dumps({"protocolVersion": 1, "status": "completed"}))
