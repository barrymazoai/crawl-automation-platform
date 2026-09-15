"""Concurrency probe: POST one image N times in parallel and print completion times.

    python probe.py --url http://127.0.0.1:8081/ocr --image D:\\ocr\\sample.jpg --parallel 1 4 8 16

Compare "wall" across parallel levels: if 8 requests finish in about the same wall time
as 1 request, the service really runs 8 lanes.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import mimetypes
import statistics
import sys
import time
import urllib.request
import uuid


def post(url: str, path: str, data: bytes) -> tuple[int, float, dict]:
    boundary = "probe-" + uuid.uuid4().hex
    ctype = mimetypes.guess_type(path)[0] or "image/jpeg"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"image.jpg\"\r\n"
            f"Content-Type: {ctype}\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            payload = json.loads(res.read().decode("utf-8"))
            return res.status, time.perf_counter() - t0, payload
    except urllib.error.HTTPError as error:
        return error.code, time.perf_counter() - t0, {"error": error.read()[:200].decode(errors="ignore")}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8081/ocr?min_score=0.3")
    ap.add_argument("--image", required=True)
    ap.add_argument("--parallel", nargs="+", type=int, default=[1, 4, 8])
    args = ap.parse_args()
    data = open(args.image, "rb").read()
    status, secs, payload = post(args.url, args.image, data)  # warm-up
    print(f"warm-up: http {status} {secs*1000:.0f} ms lines={payload.get('line_count')} backend={payload.get('backend')} pid={payload.get('worker_pid')}")
    if status != 200:
        print(json.dumps(payload)[:300]); return 1
    for n in args.parallel:
        t0 = time.perf_counter()
        with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:
            results = list(pool.map(lambda _: post(args.url, args.image, data), range(n)))
        wall = time.perf_counter() - t0
        lat = sorted(r[1] for r in results)
        pids = sorted(set(r[2].get("worker_pid") for r in results))
        ok = sum(1 for r in results if r[0] == 200)
        print(f"parallel {n:2d}: ok {ok}/{n} wall {wall*1000:.0f} ms | per-request min {lat[0]*1000:.0f} median {statistics.median(lat)*1000:.0f} max {lat[-1]*1000:.0f} ms | throughput {n/wall:.2f} img/s | worker pids {len(pids)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
