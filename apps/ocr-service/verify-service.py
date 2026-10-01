"""Supplementary contract checks; supplied probe.py remains unchanged."""
import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.request
import zipfile

from PIL import Image
from probe import post

ROOT = Path('D:/ocr')
OUT = Path(sys.argv[1])
URL = 'http://127.0.0.1:8081/ocr?min_score=0.3'

def health(_=None):
    with urllib.request.urlopen('http://127.0.0.1:8081/health', timeout=20) as response:
        return json.load(response)

healths = {}
for _ in range(5):
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        for h in pool.map(health, range(32)):
            healths[h['worker_pid']] = h
    if len(healths) == 8:
        break
assert len(healths) == 8, f'Only {len(healths)} healthy workers'
(OUT/'health.json').write_text(json.dumps(health(), indent=2))
(OUT/'all-workers-health.json').write_text(json.dumps(healths, indent=2))
for h in healths.values():
    assert h['backend'] == 'cuda'
    assert all(p[0] == 'CUDAExecutionProvider' for p in h['session_providers'].values())

warm = []
for filename in ('label.jpg', 'label-gnc.jpg'):
    path = ROOT/'samples'/filename
    data = path.read_bytes()
    seen = set()
    for wave in range(4):
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(lambda _: post(URL, str(path), data), range(16)))
        for status, seconds, body in results:
            warm.append({'image': filename, 'wave': wave, 'status': status, 'seconds': seconds,
                         'pid': body.get('worker_pid'), 'line_count': body.get('line_count'),
                         'error': body.get('error')})
            assert status == 200, body
            seen.add(body['worker_pid'])
        if len(seen) == 8:
            break
    assert len(seen) == 8, f'Not all workers warmed for {filename}'
(OUT/'warmup.json').write_text(json.dumps(warm, indent=2))

status, seconds, body = post(URL, 'label.jpg', (ROOT/'samples/label.jpg').read_bytes())
(ROOT/'samples/label.response.json').write_text(json.dumps(body, ensure_ascii=False, indent=2), encoding='utf-8')
assert status == 200, status
line_count_acceptance = body['line_count'] >= 60
assert body['text'] == '\n'.join(x['text'] for x in body['lines'])
assert body['line_count'] == len(body['lines'])
for line in body['lines']:
    assert 0.3 <= line['score'] <= 1
    assert len(line['polygon']) == 4
    assert all(len(point) == 2 and all(type(x) is int for x in point) for point in line['polygon'])

blank = io.BytesIO()
Image.new('RGB', (320, 240), 'white').save(blank, format='PNG')
blank_status, _, blank_body = post(URL, 'blank.png', blank.getvalue())
assert blank_status == 200 and blank_body['text'] == '' and blank_body['lines'] == []
methods = {}
for method in ('GET', 'HEAD'):
    try:
        urllib.request.urlopen(urllib.request.Request(URL, method=method), timeout=10)
        raise AssertionError(method+' unexpectedly accepted')
    except urllib.error.HTTPError as error:
        methods[method] = error.code
        assert error.code == 405
with zipfile.ZipFile('C:/Users/Barry/Downloads/ocr-nvidia-us.zip') as z:
    original = z.read('ocr-nvidia-us/probe.py')
assert original == (ROOT/'service/probe.py').read_bytes(), 'Acceptance probe modified'
result = {'status': 'ok', 'worker_pids': sorted(healths), 'label_line_count': body['line_count'],
          'document_60_line_acceptance': line_count_acceptance,
          'blank_status': blank_status, 'blank_line_count': 0, 'methods': methods,
          'supplied_probe_sha256': hashlib.sha256(original).hexdigest(),
          'probe_unchanged': True, 'response_file': str(ROOT/'samples/label.response.json')}
(OUT/'contract-result.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2), flush=True)
