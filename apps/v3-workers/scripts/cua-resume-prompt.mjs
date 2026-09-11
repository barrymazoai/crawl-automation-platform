import assert from 'node:assert/strict';

export const CHROME_RESUME_BOOTSTRAP = `本次 exec resume 恢复的是对话，不保证恢复 Computer Use 的 JavaScript 运行态。把本次 cua_repl 当作全新会话：此前的 app/tab/browser 变量、元素索引和截图坐标均不可复用。
第一次 cua_repl 调用必须且只能执行这一条初始化语句：
var resumedChrome = await cua.getApp("com.google.Chrome");
不要在第一次调用中附加其他 API、截图或等待。先阅读这次工具返回的文档和初始 UI 状态，再按本次公开 API 使用 resumedChrome 获取新 AX/截图。不要先调用 app.getAXStateAndScreenshot() 或任何旧变量；只用这次返回的窗口、元素和坐标。
初始化只是只读恢复连接，不是验证码点击。若不能明确确认当前窗口和 URL，停止并报告 TARGET_WINDOW_NOT_RESOLVED；权限仍要求人工操作时停止，不绕过。`;

export function buildHumanResumePrompt(receipt) {
  for (const key of ['id','threadId','url','question','reply']) assert.ok(typeof receipt[key] === 'string' && receipt[key].trim(), `MISSING_${key}`);
  return `${CHROME_RESUME_BOOTSTRAP}

用户已在认证网页中针对本次请求作出回复，原文如下：
${receipt.reply}

确认绑定：${receipt.id}，目标 ${receipt.url}，会话 ${receipt.threadId}。仅限原请求：${receipt.question}
重新获取 Chrome 后，先只读核对当前标签、页面挑战和目标是否仍与此前等待确认时相同；如果页面/挑战/窗口已变化或无法确认，停止并重新请求确认，不执行旧操作。不得扩大权限或绕过工具要求；若工具仍要求人工操作/系统授权则停下。本次回复只使用一次。进度条或工具调用成功不代表验证通过，必须观察到准确目标产品内容。`;
}

export function cuaInitializationStatus(calls) {
  const first = calls.find(call => call.server === 'cua_repl' && call.tool === 'js');
  if (!first) return 'NOT_OBSERVED';
  return first.initializesChrome && first.status === 'completed' ? 'INITIALIZED' : 'FAILED';
}
