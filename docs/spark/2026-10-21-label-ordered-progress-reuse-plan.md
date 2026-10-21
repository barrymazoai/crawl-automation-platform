# 标签有序走法：复用上一轮的进度记录，不再逐轮重验全部来源

> 2026-10-21。Owner 看到 DTC 一件商品 7 到 14 分钟后决定优化（"把它改成有状态的"）。只是计划，未写代码。

## 现状与数字

images-first 有序走法每试完一张图调用 `inspectLabelImage` 判断"完整了吗"。活动无状态，`orderedEvidence`
（`packages/processing/src/label/ordered-evidence.ts`）对清单上**每一个**已尝试来源都重新读原图、读 OCR/关键词记录、
重跑 `plans.source`（日志里的 `prepareLabelSource`）。13 张图的 Sambucol day-and-night 2x：

| 项目 | 次数 | 秒 |
|---|---|---|
| `prepareLabelSource`（重验） | 126 | 203 |
| `inspectLabelImage` | 13 | 175 |
| 真正干活：采集 12 + 下载 36 + OCR 14 + 视觉 24 + 组装收录 14 | | 约 100 |
| 端到端 | | 867 |

复杂度是 1+2+…+n。Amazon 一件 3 张图感觉不到；Shopify 官网 8 到 13 张就从几十秒涨到十几分钟。

## 复用什么

- 每一轮 `inspect` 已经把结果写成不可变的按前缀寻址记录：`orderedProgressKey(input, states)` →
  `v3/channel-labels/<op>/progress/<sha256(states)>.json`，内容 `OrderedDiagnosticsSchema`（request、outcomes、codes、
  sourceOutcomes）。上一轮的记录就是"前 n-1 张图"的已验证结论，下一轮只是没有去读它。
- `readSourceState` 已经对 `unresolved`/`rejected` 和带 reason 的 page `not_matched` 做了"不读原件、直接按状态给结论"，
  本次把 file-image 的 `not_matched` 纳入同一类处理，只是依据换成上一轮自己写的、哈希寻址的记录。

## 改法（全部在 `packages/processing/src/label`，活动内部，不改 workflow 命令序列，不需要 patched 标记）

1. `ordered-diagnostics.ts`：`OrderedDiagnosticsSchema` 增加可选 `sourceDiagnostics`（现有 `SourceDiagnostic` 形状），
   `inspect` 写记录时一并保存。旧记录没有该字段照样能读。
2. `ordered-evidence.ts`：`orderedEvidence` 新增可选参数 `previous`（上一轮记录）。对 `request.states` 中除最后一个之外、
   状态为 `not_matched` 且无 reason 的 file-image 来源：若 `previous.request.input` 与本次深相等、`previous.request.states`
   等于本次前缀、且该来源在 `previous.outcomes` 中状态也是 `not_matched`，则不读原件、不跑 `plans.source`，直接复用其
   reason（`CHANNEL.LABEL_NO_SOURCE`，executed）和 `sourceDiagnostics` 里的诊断（keyword_screen_missed / no_text）。
   其他状态（`registered`、`review`）照旧全量重验：它们才是进入合并的来源，"回执不可信"的原则对它们不变。
3. `ordered-selection.ts`：`inspect` 和 `manifest` 在调用 `orderedEvidence` 前读 `orderedProgressKey(input, states.slice(0,-1))`
   （`manifest` 读完整 attempted 前缀对应的记录），读不到或校验不过就走现有全量路径。读取失败只记 recovery，不影响结果。
4. 不改 `mergeLabelProduct`、不改 workflow、不改 Review 内容：`outcomes` 仍对每个来源输出，复用的来源 evidenceKeys 为空
   与现在一致（not_matched 本来就没有 result 记录）。

## 自己写的理由

没有现成库能做"按内容寻址的前缀记录复用"，这是本仓库自己的协议；改动约 60 行。

## 验证

- `pnpm check` 与 `packages/processing/src/label`、`packages/workflows/src/label` 现有测试。
- Server 一 部署后，用同一组 Sambucol/Nature's Truth 商品再跑：`prepareLabelSource` 次数应等于图片数（加少量 registered 重验），
  `inspectLabelImage` 单次时长不再随图片序号增长；端到端从 7 到 14 分钟降到约 3 到 5 分钟（剩余是逐张串行和 Temporal 跳转）。
- Amazon 同步受益，验收时看 Amazon 完成件中位时间是否下降。

## 不在本次

- 先把所有图 OCR 完、只对关键词命中的图调视觉模型、按命中而非文件名排序：这要改 workflow 循环（需要 patched 标记），
  另立工单，预计再把每件从 3 到 5 分钟压到 2 分钟以内。
