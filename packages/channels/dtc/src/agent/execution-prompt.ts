/** A yielded shell call is still executing; do not overlap browser rounds or finalise its work. */
export function captureExecutionRules(timeBudgetMs = 900_000): string {
  return `宿主本次Codex总预算为${Math.floor(timeBudgetMs / 60_000)}分钟（含读skill、观察和执行），不能自行写更大的预算冒充已获时间。
执行浏览器脚本后，工具返回running/session_id/cell_id表示原调用仍在运行，不是失败。使用该工具提供的write_stdin/wait续等同一调用到明确退出；每次等待30–60秒，不高频轮询。原调用退出前禁止另开Ego调用观察/导航同一页、重跑脚本、写替代结果或返回最终complete/needs_review。
长目录的catalog-discovery.json只在执行结束写出；尚不存在或暂时无stdout不证明停滞。可只读catalog-progress.jsonl查看真实逐页进度；页数/时间在推进就继续等。确实的错误、预算耗尽或用户控制边界才保留原因停止，不能依据一两次文件检查推断浏览器卡死。`;
}
