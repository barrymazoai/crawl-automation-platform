# 要交回的证据

装完后把下面五样原样贴回来，缺一样都不算验收通过。

1. **ONNX Runtime 后端确认。** 这条命令的完整输出：
   - NVIDIA：`python -c "import onnxruntime as ort; ort.preload_dlls(); print(ort.__version__, ort.get_available_providers())"`
   - AMD：`python -c "import onnxruntime as ort; print(ort.__version__, ort.get_available_providers())"`
   NVIDIA 必须含 `CUDAExecutionProvider`，AMD 必须含 `DmlExecutionProvider`。
2. **健康检查。** `curl http://127.0.0.1:<端口>/health` 的完整 JSON，必须能看到 `"status":"ok"`、`healthy_backends`、`total_backends` 三个字段，且 `healthy_backends` 等于实际进程数。
3. **探测输出。** `probe.py` 对 `label.jpg` 跑 `--parallel 1 4 8 16` 的完整输出，以及对 `label-dtc.jpg` 跑 `--parallel 1 8` 的完整输出。
4. **一份完整响应。** 对 `label.jpg` 单次 POST 的完整 JSON 存成文件交回，用来核对 `text`、`lines`、`score`、`polygon` 的格式。例如：
   `curl -s -F "file=@D:\ocr\samples\label.jpg;type=image/jpeg" "http://127.0.0.1:<端口>/ocr?min_score=0.3" > D:\ocr\samples\label.response.json`
5. **显卡占用截图或文字。** 8 路探测进行中的 `nvidia-smi` 输出，或 AMD 的任务管理器 GPU 页面截图，证明推理确实在显卡上。

另外写明：安装目录、Python 版本、`pip list` 里 rapidocr 和 onnxruntime 的版本、端口号、开机自启是否已设置。
