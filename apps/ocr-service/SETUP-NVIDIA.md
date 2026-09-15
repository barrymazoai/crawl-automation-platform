# 美国 Windows（RTX 3090）：OCR 服务 + OCR worker

## 包里有什么

| 文件 | 用途 | 必须用吗 |
| --- | --- | --- |
| `SETUP-NVIDIA.md` | 本文档 | 是 |
| `ocr_server.py` | 参考实现：RapidOCR 加 ONNX Runtime CUDA，FastAPI 服务 | 否，可重写，接口必须一致 |
| `start-nvidia.cmd` | 参考启动脚本：设 D 盘路径、环境变量，起 8 个进程 | 否 |
| `requirements-common.txt` | 参考实现的 Python 依赖 | 否 |
| `probe.py` | 验收脚本，只用标准库 | 是 |
| `samples/label.jpg` | 验收样图，GNC 真实背标，2400×2400，现有 CPU 服务识别 91 行 | 是 |
| `samples/label-dtc.jpg` | 第二张样图，Supplement Facts 面板，1920×1920，现有 CPU 服务识别 28 行 | 是 |
| `samples/*.reference.json` | 现有 CPU 服务对这两张图的完整响应，用来对格式 | 是 |
| `EVIDENCE.md` | 要交回的证据清单 | 是 |

这台机器 mini 和 MacBook 都直接连不上，分两个阶段。**第一阶段**装 OCR 服务并本机验收，现在做。**第二阶段**部署 OCR worker 连 Temporal，由 mini 侧验收，等 mini 生成部署包后再发指令。

## 第一阶段：OCR 服务

### 必须满足的四条

1. **接口。** `POST http://127.0.0.1:8081/ocr?min_score=0.3`，multipart/form-data，字段名 `file`。返回 JSON：`text` 是所有行用 `\n` 拼接的字符串；`lines` 数组每项 `{"text","score","polygon"}`，`score` 0 到 1，`polygon` 四个整数 `[x,y]` 点；只保留 `score >= min_score` 的行；没文字也返回 200、空 `text`、空 `lines`；额外字段随意，建议带 `backend`、`worker_pid`、`elapsed_ms`；GET 或 HEAD 打 `/ocr` 返回 405。
   - `GET /health` 必须返回 200 和 JSON，且**必须**包含这三个字段：`"status": "ok"`、`"healthy_backends": <整数>`、`"total_backends": <整数>`。mini 的健康探测只认这三个字段，`healthy_backends` 小于 2 或字段缺失都会把 OCR 资源判成不可用，整条流水线停止派发。多进程服务每个进程都按"配置的进程总数"报这两个数即可；其他字段随意加。
2. **走显卡，真 8 路。** PP-OCRv5 英文检测加识别。8 个独立进程各持一份模型，不是一个进程排队。CPU 只有 6 线程，每进程推理线程设 1。驱动 528 以上。
3. **全部在 D 盘。** Python、虚拟环境、模型、pip 缓存、临时目录、日志都在 `D:\ocr`，C 盘不放东西。
4. **只监听 127.0.0.1。** 调用方是本机 worker。

### 用参考实现的话

```bat
mkdir D:\ocr D:\ocr\service D:\ocr\tmp D:\ocr\logs D:\ocr\pip-cache D:\ocr\samples
winget install --id Python.Python.3.11 --location D:\ocr\python --accept-package-agreements --accept-source-agreements
set PIP_CACHE_DIR=D:\ocr\pip-cache
D:\ocr\python\python.exe -m venv D:\ocr\venv
D:\ocr\venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r D:\ocr\service\requirements-common.txt
pip install onnxruntime-gpu nvidia-cuda-runtime-cu12 nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cufft-cu12 nvidia-curand-cu12
python -c "import onnxruntime as ort; ort.preload_dlls(); print(ort.__version__, ort.get_available_providers())"
```

最后一行必须打印出 `CUDAExecutionProvider`。把包里的文件放到 `D:\ocr\service\`，样图放 `D:\ocr\samples\`。先单进程跑一次让模型下载到 venv 里：

```bat
set OCR_BACKEND=cuda
cd /d D:\ocr\service
python ocr_server.py
```

看到 `engine ready backend=cuda` 后 Ctrl+C，再用 `start-nvidia.cmd` 起 8 路。如果 rapidocr 报 `params` 键名不认识，对照 `D:\ocr\venv\Lib\site-packages\rapidocr\config.yaml` 改 `ocr_server.py` 里的 `_build_params`。

### 验收

```bat
python D:\ocr\service\probe.py --url http://127.0.0.1:8081/ocr?min_score=0.3 --image D:\ocr\samples\label.jpg --parallel 1 4 8 16
python D:\ocr\service\probe.py --url http://127.0.0.1:8081/ocr?min_score=0.3 --image D:\ocr\samples\label-dtc.jpg --parallel 1 8
```

通过标准：8 路的 wall 接近 1 路的 wall；pids 显示 8；单张 50 到 200 毫秒；`label.jpg` 识别 80 行以上且文字里有 Supplement Facts，`label-dtc.jpg` 识别 25 行以上。8 路 wall 超过 1 路 4 倍就是显卡排队，降到 4 路。要交回的东西见 `EVIDENCE.md`。

### 自启

任务计划程序，触发器"登录时"，运行 `D:\ocr\service\start-nvidia.cmd`，勾选"不管用户是否登录都要运行"。

## 第二阶段：OCR worker

**它是什么。** V3 现成的 `channel-label` worker 的 `ocr` 角色：连 Temporal 领 `ocrFile` 任务，从 R2 取图，调本机 8081，把结果写回 R2 并登记。部署形式同这台机器上的 DTC 节点：`D:\crawlv3-ocr\release` 放构建产物，`D:\crawlv3-ocr\private` 放私有配置和 Temporal mTLS 证书，先 doctor 再 start，见仓库 `apps/v3-workers/DTC_WINDOWS.md`。

**它需要什么。** Temporal 地址和证书、R2 凭据、存储 ID、任务队列名、OCR 服务地址，由 mini 侧生成并随部署包给出，这一阶段不用准备。

**要先定的事。** 这个角色现在直接写业务数据库登记结果和 Review，数据库在 mini 上，美国机器连不到，DTC 节点的设计也刻意不让 Windows 碰数据库。两种解法：改代码让 OCR 角色只写 R2、登记交给 mini 上已有的回执角色，约一天，推荐；或者给美国机器打一条到 mini 数据库的加密通道，快但 Windows 会持有数据库凭据，且走跨洋链路。

**怎么知道成了。** 全部从 mini 侧看：Temporal 上出现这台机器的 worker 在 OCR 队列轮询；资源表里有它持续更新的心跳；从 mini 提交一个 Amazon 商品后 `ocrFile` 结果落到 R2 和数据库，返回里 `backend` 是 `cuda`、`worker_pid` 是这台机器的进程。第三条过了才算完成。
