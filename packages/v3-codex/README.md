# V3 共享 Codex 通信层

由 `v3-text` 的已测试驱动提取，供文本和视觉模块共同依赖。没有 OCR、Formula、数据库、R2 或任务调度逻辑。

`CodexRpc` 管理独占子进程及 stdio；`assertCodexModel` 核对指定提供商、模型与 modalities/effort；`runCodexTurn` 支持文本加一张 localImage。`runCodexTextTurn` 保持原有纯文本调用接口，并剔除额外图片字段。`codexConnection` 保持受限无工具运行环境及既有代理配置。

保留既有 TEXT 错误码以兼容文本模块，视觉模块在边界转换为 VISION 分类。内部续调由 Codex 管理，不重开外层执行。原文本包兼容入口与 127 项回归测试继续保留；视觉协议测试校验原图 hash、图片能力、独立进程及 original detail。

依赖顺序：contracts → codex → text / vision。不要在此包加入任一业务模块的依赖。
