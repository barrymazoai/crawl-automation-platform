# DTC Workflow 跨平台构建：行尾和调试映射

Windows 对 main `b1d4f2f` 的现场复核证明，第一次修正不完整：执行部分仍含 3 个 CRLF，编译器的完整 source map 仍有差异。Windows 将执行部分转成 LF 后，其 SHA-256 与 Git 记录完全一致：`dd0599866c5647b2b15236db8c4654267e11268b3c4e2aa4a754b86e3b3c29b3`。因此已知差异来自换行及调试资料，不能据完整 bundle 的不同就断言业务代码不同。Windows 停止部署符合硬校验要求。

第二次修正由 `portableWorkflowBundle` 完成：

- 将执行部分的实际 CRLF 转为 LF，保留转义字符串中的 `\\r`、`\\n`，遇到孤立 CR 拒绝构建。
- Temporal SDK 1.23.0 的 Worker 必须读取内联 source map。因此从规范化后的执行代码生成稳定的逐行映射，格式标识为 `generated-js-lines/1`。执行代码相同就生成相同的完整运行 bundle。
- 原编译器的 TypeScript source map 单独保存在 `product-workflows.compiler.map`，供离线排错。自动堆栈现在定位到生成 JS 的行首，不再直接定位原 TypeScript；需要 TypeScript 位置时结合单独保留的编译器 map 离线排错。
- Worker 继续对完整 `product-workflows.cjs` 做严格 buildId 校验。运行代码变化仍改变 buildId，没有跳过检查或直接采纳 Windows 上次的完整 hash。

构建结果：

- 18 个 JS，Activity build 不变：`4aefac185c12264127f7c956dfa149731d28805a3b9366361f527076142bfa47`。
- Workflow build：`22f4056196e52705fc12c50a9a59c07bc31a7f604160cc63ec65a4eb8466b83f`。
- 执行部分 SHA-256 不变，与用户 Windows 报告中统一换行后的值相同。

验证：

- 本地纯构建及 4 项构建单元测试通过：3 个 CRLF 与任意编译器 map 差异归一、真实执行代码变更仍改变完整 hash、实际 SDK source-map consumer 能解析行号、异常输入拒绝。
- Mac mini 使用本次真实 bundle 运行 `dtc-node-control`、`dtc-stream`、`channel-stream`：5 项测试全部通过，包含成功/失败/取消及 21 份工作流历史重放。
- Mini 仅更新 Innerbody 的 26 个配套 Worker，保留原 90 个 Worker；更新前只读确认该来源没有业务提交，正常退出旧的 26 个进程后备份原 release/config 并重新准备。
- 更新后于 `2026-09-11T07:57:36.780Z` 核验：DTC supervisor PID 73765，26/26 ready；原 supervisor PID 29766，90/90 ready。真实 Temporal 预检 `v3-dtc-doctor-1132d30b-d5d0-4e3b-91fd-54809ae80b0a` 返回 ready。Mini 实际 routing 与 Git 配置逐项一致。

Git 的部署配置和 Windows 操作说明同步更新。凭据无需更换，Windows 继续从 Git 拉代码。本记录不声称已经取得 Windows 本次原生构建结果；必须重新 build:dtc 并通过原有硬校验后才能配置、doctor 和启动。
