# crawlv3 OCR service

Two Windows machines, one HTTP contract (the one `packages/v3-ocr` `MultipartOcr` already speaks):

- `POST /ocr?min_score=0.3`, multipart field `file`; response `{text, lines[{text, score, polygon}], ...}`
- `GET /health` reports backend and ONNX providers

| Machine | What runs there | Doc |
| --- | --- | --- |
| Local Windows, RX 9070 XT, same LAN as Mini | OCR service only (DirectML). The `ocrFile` worker stays on Mini. | `SETUP-AMD.md` |
| US Windows, RTX 3090 | OCR service (CUDA) plus an OCR worker connected to Temporal, verified from Mini. | `SETUP-NVIDIA.md` |

`ocr_server.py`, `start-*.cmd`, `requirements-common.txt` are a reference implementation; any server meeting the contract is fine.
`probe.py` measures real concurrency and is the acceptance test on both machines.
