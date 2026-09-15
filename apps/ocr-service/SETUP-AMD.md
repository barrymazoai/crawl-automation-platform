# 本地 Windows（RX 9070 XT）：只装 OCR 服务，worker 留在 mini

## 包里有什么

| 文件 | 用途 | 必须用吗 |
| --- | --- | --- |
| `SETUP-AMD.md` | 本文档 | 是 |
| `ocr_server.py` | 参考实现：RapidOCR 加 ONNX Runtime DirectML，FastAPI 服务 | 否，可重写，接口必须一致 |
| `start-amd.cmd` | 参考启动脚本：设 D 盘路径、环境变量，起 8 个进程 | 否 |
| `requirements-common.txt` | 参考实现的 Python 依赖 | 否 |
| `probe.py` | 验收脚本，只用标准库 | 是 |
| `samples/label.jpg` | 验收样图，GNC 真实背标，2400×2400，现有 CPU 服务识别 91 行 | 是 |
| `samples/label-dtc.jpg` | 第二张样图，Supplement Facts 面板，1920×1920，现有 CPU 服务识别 28 行 | 是 |
| `samples/*.reference.json` | 现有 CPU 服务对这两张图的完整响应，用来对格式 | 是 |
| `EVIDENCE.md` | 要交回的证据清单 | 是 |

这台机器和 mini 同一局域网，就是现在跑 CPU 版 OCR 的那台（192.168.0.6:8081）。**只换 OCR 服务，不部署任何 Temporal worker**，调用它的 worker 继续在 mini 上，mini 的代码和地址都不动。

## 必须满足的四条

1. **接口。** `POST http://<本机IP>:8081/ocr?min_score=0.3`，multipart/form-data，字段名 `file`。返回 JSON：`text` 是所有行用 `\n` 拼接的字符串；`lines` 数组每项 `{"text","score","polygon"}`，`score` 0 到 1，`polygon` 四个整数 `[x,y]` 点；只保留 `score >= min_score` 的行；没文字也返回 200、空 `text`、空 `lines`；额外字段随意，建议带 `backend`、`worker_pid`、`elapsed_ms`；GET 或 HEAD 打 `/ocr` 返回 405。
   - `GET /health` 必须返回 200 和 JSON，且**必须**包含这三个字段：`"status": "ok"`、`"healthy_backends": <整数>`、`"total_backends": <整数>`。mini 的健康探测只认这三个字段，`healthy_backends` 小于 2 或字段缺失都会把 OCR 资源判成不可用，整条流水线停止派发。多进程服务每个进程都按"配置的进程总数"报这两个数即可；其他字段随意加。
2. **走显卡，真 8 路。** AMD 卡在 Windows 上用 ONNX Runtime 的 DirectML 后端，PaddleOCR 原生 GPU 不支持 AMD。PP-OCRv5 英文检测加识别。8 个独立进程各持一份模型。
3. **全部在 D 盘。** `D:\ocr` 下，C 盘不放东西。
4. **先在 8082 试跑，验收后再切到 8081**，或验收时停掉旧的 CPU 服务。mini 指向的是 8081。

## 用参考实现的话

```bat
mkdir D:\ocr D:\ocr\service D:\ocr\tmp D:\ocr\logs D:\ocr\pip-cache D:\ocr\samples
winget install --id Python.Python.3.11 --location D:\ocr\python --accept-package-agreements --accept-source-agreements
set PIP_CACHE_DIR=D:\ocr\pip-cache
D:\ocr\python\python.exe -m venv D:\ocr\venv
D:\ocr\venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r D:\ocr\service\requirements-common.txt
pip install onnxruntime-directml
python -c "import onnxruntime as ort; print(ort.__version__, ort.get_available_providers())"
```

最后一行必须打印出 `DmlExecutionProvider`。打印不出就是装成了 CPU 版，`pip uninstall -y onnxruntime` 后重装 `onnxruntime-directml`。Python 用 3.11 或 3.12，3.13 没有 DirectML 的包。

把包里的文件放到 `D:\ocr\service\`，样图放 `D:\ocr\samples\`。先单进程跑一次让模型下载到 venv 里：

```bat
set OCR_BACKEND=directml
set OCR_PORT=8082
cd /d D:\ocr\service
python ocr_server.py
```

看到 `engine ready backend=directml` 后 Ctrl+C，把 `start-amd.cmd` 里的 `OCR_PORT` 改成 8082 试跑，起 8 路。rapidocr 报 `params` 键名不认识时，对照 `D:\ocr\venv\Lib\site-packages\rapidocr\config.yaml` 改 `ocr_server.py` 里的 `_build_params`。

## 验收

```bat
python D:\ocr\service\probe.py --url http://127.0.0.1:8082/ocr?min_score=0.3 --image D:\ocr\samples\label.jpg --parallel 1 4 8 16
python D:\ocr\service\probe.py --url http://127.0.0.1:8082/ocr?min_score=0.3 --image D:\ocr\samples\label-dtc.jpg --parallel 1 8
```

通过标准：8 路的 wall 接近 1 路的 wall；pids 显示 8；单张 100 到 400 毫秒；`label.jpg` 识别 80 行以上且文字里有 Supplement Facts，`label-dtc.jpg` 识别 25 行以上。8 路 wall 超过 1 路 4 倍就是显卡排队，降到 4 路。要交回的东西见 `EVIDENCE.md`。本机通过后，mini 侧会跨局域网再打一次同样的探测，那一步不用做。

## 切换到 8081 之后 mini 侧要改的，不在这台机器上做

- 部署清单里 `windows-ocr` 资源 capacity 从 2 改 8，数据库 `resource_capacity` 同步。
- 长期用 8082 的话 OCR 角色配置里的 endpoint 要改；切回 8081 则不用动。

## 防火墙与自启

- 只放行局域网：`netsh advfirewall firewall add rule name="crawlv3-ocr" dir=in action=allow protocol=TCP localport=8081 remoteip=192.168.0.0/24`
- 任务计划程序，触发器"登录时"，运行 `D:\ocr\service\start-amd.cmd`，勾选"不管用户是否登录都要运行"。
