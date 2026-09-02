/**
 * 反检测层：让 CDP 驱动的 Chrome 在 PerimeterX 眼里更像真人。
 *
 * PerimeterX 不只看 IP，还给"访客行为"打分：CDP 的自动化痕迹、缺失的鼠标轨迹、
 * 过快的请求时序都会推高机器人分。裸 CDP 抓取实测通过率只有 1/8——第一次靠
 * PX 的宽限过，之后行为分累积就全被 307 拦。
 *
 * 两手：
 * 1. 注入脚本抹掉 navigator.webdriver 等自动化标志（在页面任何脚本前执行）；
 * 2. 导航后补一段真人行为——鼠标移动、滚动、随机停顿，喂给 PX 的行为采集器。
 */

/** 在文档任何脚本之前执行，抹平最容易被 PX/PX-like 检测的自动化痕迹。 */
export const STEALTH_SCRIPT = String.raw`
(() => {
  const patch = (obj, prop, value) => {
    try { Object.defineProperty(obj, prop, { get: () => value, configurable: true }); } catch (e) {}
  };
  // 1. navigator.webdriver 必须是 undefined（自动化最硬的标志）
  patch(navigator, 'webdriver', undefined);
  // 2. chrome 运行时对象——真 Chrome 有，无头/纯 CDP 常缺
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};
  // 3. plugins / mimeTypes 长度非零（真浏览器有 PDF 插件等）
  if (navigator.plugins && navigator.plugins.length === 0) {
    patch(navigator, 'plugins', { length: 3, 0:{}, 1:{}, 2:{} });
  }
  // 4. permissions.query 对 notifications 的经典探测
  try {
    const orig = navigator.permissions && navigator.permissions.query;
    if (orig) navigator.permissions.query = (p) =>
      p && p.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : orig(p);
  } catch (e) {}
  // 5. WebGL vendor/renderer 报成真实显卡，别露出 SwiftShader
  try {
    const gp = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';           // UNMASKED_VENDOR_WEBGL
      if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
      return gp.call(this, p);
    };
  } catch (e) {}
})();
`;

const rand = (min: number, max: number) => Math.floor(min + Math.random() * (max - min));

/**
 * 用 CDP 派发真人般的鼠标移动 + 滚动。
 * PX 采集鼠标轨迹作为"活人"信号，纯导航不产生任何轨迹，会被扣分。
 */
export async function simulateHumanBehavior(
  dispatch: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
  // 鼠标从一点移到另一点，分几步走出带抖动的轨迹（不是瞬移）
  let x = rand(200, 600);
  let y = rand(200, 500);
  const steps = rand(5, 9);
  const targetX = rand(400, 1200);
  const targetY = rand(300, 700);
  for (let i = 1; i <= steps; i += 1) {
    x += (targetX - x) / (steps - i + 1) + rand(-8, 8);
    y += (targetY - y) / (steps - i + 1) + rand(-8, 8);
    await dispatch("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y) });
    await sleep(rand(20, 70));
  }
  // 随机滚动一两下，模拟浏览
  for (let i = 0; i < rand(1, 3); i += 1) {
    await dispatch("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY: rand(200, 500),
    });
    await sleep(rand(150, 400));
  }
  // 阅读停顿
  await sleep(rand(300, 900));
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
