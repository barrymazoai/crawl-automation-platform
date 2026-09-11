# DTC Workflow buildId 的构建路径差异

后续 Windows 复核确认本次修正不完整；当前修复及限制见 [行尾和调试映射修正](2026-09-11-dtc-workflow-build-lf.md)。以下保留第一次修正的历史记录。

Windows 在 main `6044b27` 连续两次构建出相同的 Activity build，但 Workflow build 与 Mini 的发布配置不同。核查 Temporal SDK 1.23.0 本地打包代码，默认使用 inline-source-map、带 fullhash 的调试文件名，以及 `[absolute-resource-path]`。

实际 Mac 产物的 source map 有 166 个 source，其中包含构建目录 `/Users/...` 的绝对路径；SDK 自动生成入口的 source content 还含绝对 require 路径。因此不能直接把这份未规范化产物的完整字节 hash 当作不同机器重建的统一标识。Windows 拒绝部署符合现有校验要求，凭据无需修改。

修正只处理 Workflow source map：仓库源码与依赖使用稳定相对调试路径，生成入口中的绝对路径同步规范化，源文本行尾统一为 LF，调试文件名固定为 product-workflows.cjs。完整 bundle 仍参与严格 buildId 校验，不接受忽略 Workflow hash，也没有把 Windows 报告的数值直接填成期望值。

验证：

- 3 项构建单元测试通过：Mac/Windows 路径与行尾、未知路径拒绝、SDK 自动入口内容。
- 完整实际产物对比证明：sourceMappingURL 前的所有执行代码字节不变；原绝对构建路径从 source map 清除。
- TypeScript 和 build:dtc 通过。Activity build 仍是 `4aefac185c12264127f7c956dfa149731d28805a3b9366361f527076142bfa47`。
- 新 Workflow build 为 `05ee358c158ac5f985aa9d0bdaccfddba244f43cf63f38954fafb2cd13b2d746`。
- Mini 的节点/目录控制、DTC 新旧链路及原渠道流式测试 5 项通过，覆盖成功/失败/取消和 21 份工作流历史重放。

Git 部署配置随修正更新。Windows 需要拉取修正后重新构建并现场复核；本记录不声称已取得 Windows 新构建结果。若仍不一致，准备脚本会报告执行代码独立 hash，便于区分其他构建差异，继续保留硬校验。
