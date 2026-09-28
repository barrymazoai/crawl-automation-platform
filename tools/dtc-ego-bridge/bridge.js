// DTC CDP bridge for Ego Lite. Runs inside `ego-browser nodejs < bridge.js` with
// `globalThis.BRIDGE_ENV = {...}` prepended by start.sh.
//
// Serves a Chrome-compatible loopback debugging endpoint (http://127.0.0.1:<port>/)
// backed by ONE Ego TaskSpace. Only pages this bridge created (and their popups) are
// visible; the user's tabs and other TaskSpaces are never listed, attached or closed.
// Ego forbids Target.createTarget and has no Browser.getVersion, so /json/new and
// Target.createTarget map to task.newPage(), and the browser identity is answered here.
// Ego delivers page events through a polled buffer (page.events()); the bridge drains it
// after every command and on a short timer and forwards events to attached sessions.
//
// BRIDGE_ENV: port        loopback port to listen on
//             stateDir    directory for state.json and bridge.log (created)
//             pauseFile   the DTC browser.pauseFile; created when Ego reports user control
//             spaceName   TaskSpace name used when no saved space exists (default dtc-bridge)
//             pollMs      event poll interval (default 40)

const http = await import("node:http");
const fs = await import("node:fs/promises");
const path = await import("node:path");
const crypto = await import("node:crypto");

const env = globalThis.BRIDGE_ENV ?? {};
const PORT = Number(env.port);
const STATE_DIR = env.stateDir;
const PAUSE_FILE = env.pauseFile;
const POLL_MS = Number(env.pollMs || 40);
if (!Number.isInteger(PORT) || PORT < 1024 || !STATE_DIR || !path.isAbsolute(STATE_DIR) || !PAUSE_FILE || !path.isAbsolute(PAUSE_FILE)) throw Error("BRIDGE_ENV needs port, absolute stateDir and absolute pauseFile");
await fs.mkdir(STATE_DIR, { recursive: true });
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LOG_FILE = path.join(STATE_DIR, "bridge.log");
const MAX_PAGES = 20;

const log = async (event, data = {}) => { const line = JSON.stringify({ at: new Date().toISOString(), event, ...data }); console.log(line); await fs.appendFile(LOG_FILE, line + "\n").catch(() => {}); };
const USER_CONTROL_RX = /user now controls|takeOverTaskSpace|waitForControl|handed? (off|to the user)|control of this space/i;
const exists = (p) => fs.stat(p).then(() => true, () => false);

// ---------- TaskSpace and owned pages ----------
let state = { spaceId: null, instanceId: null, pages: [] };
try { state = { ...state, ...JSON.parse(await fs.readFile(STATE_FILE, "utf8")) }; } catch {}
async function saveState() { const tmp = STATE_FILE + ".tmp"; await fs.writeFile(tmp, JSON.stringify(state, null, 1) + "\n"); await fs.rename(tmp, STATE_FILE); }

let task;
if (state.spaceId != null) {
  try { task = await taskSpace(state.spaceId); }
  catch (e) {
    // Never take the space back from the user: stop and leave it to them.
    if (USER_CONTROL_RX.test(String(e?.message))) { await fs.writeFile(PAUSE_FILE, "ego user control at bridge start\n", { flag: "a" }); await log("user-control-at-start", { spaceId: state.spaceId, error: String(e?.message).slice(0, 300) }); throw e; }
    await log("saved-space-unavailable", { spaceId: state.spaceId, error: String(e?.message).slice(0, 300) });
  }
}
if (!task) { task = await taskSpace(env.spaceName || "dtc-bridge"); state.pages = []; }
// The instance id names this TaskSpace; page journals bound to it stay valid across bridge restarts.
if (state.spaceId !== task.spaceId || !state.instanceId) state.instanceId = crypto.randomUUID();
state.spaceId = task.spaceId;

// Owned pages: targetId -> Page handle. Rebuild from the space's managed pages.
const owned = new Map();
{
  const managed = new Map((await task.pages()).map((p) => [p.targetId, p]));
  for (const rec of state.pages) { const p = managed.get(rec.targetId); if (p) owned.set(rec.targetId, p); }
  state.pages = [...owned.keys()].map((targetId) => ({ targetId, label: owned.get(targetId).label }));
}
await saveState();
await log("start", { port: PORT, spaceId: task.spaceId, instanceId: state.instanceId, ownedPages: owned.size });

async function userControl(error) {
  if (!USER_CONTROL_RX.test(String(error?.message ?? error))) return false;
  if (!(await exists(PAUSE_FILE))) { await fs.writeFile(PAUSE_FILE, `ego user control ${new Date().toISOString()}\n`); await log("user-control", { error: String(error?.message ?? error).slice(0, 300) }); }
  return true;
}

// All browser targets, filtered to owned pages and their popup descendants.
async function visibleTargets() {
  const all = (await task.cdp("Target.getTargets")).targetInfos;
  const ids = new Set([...owned.keys()].filter((id) => all.some((t) => t.targetId === id)));
  for (let grew = true; grew;) { grew = false; for (const t of all) if (t.type === "page" && t.openerId && ids.has(t.openerId) && !ids.has(t.targetId)) { ids.add(t.targetId); grew = true; } }
  // A popup of an owned page belongs to this TaskSpace; adopt it so it can be driven and closed.
  return all.filter((t) => ids.has(t.targetId));
}
async function pageFor(targetId) {
  let p = owned.get(targetId);
  if (p) return p;
  const tab = (await task.tabs()).find((t) => t.targetId === targetId);
  if (!tab) throw cdpError(-32000, "No target with given id found");
  p = tab.label ? task.page(tab.label) : await task.adopt(tab.page);
  owned.set(targetId, p); state.pages.push({ targetId, label: p.label }); await saveState();
  return p;
}
async function createPage(url) {
  if (owned.size >= MAX_PAGES) throw cdpError(-32000, "bridge page limit reached");
  const p = await task.newPage();
  const targetId = p.targetId;
  owned.set(targetId, p); state.pages.push({ targetId, label: p.label }); await saveState();
  if (url && url !== "about:blank") await p.cdp("Page.navigate", { url });
  await log("page-created", { targetId, label: p.label, url });
  return targetId;
}
async function closePage(targetId) {
  const known = owned.get(targetId) ?? (await pageFor(targetId).catch(() => null));
  if (!known) return false;
  await known.close();
  owned.delete(targetId); state.pages = state.pages.filter((r) => r.targetId !== targetId); await saveState();
  detachTarget(targetId);
  await log("page-closed", { targetId });
  return true;
}

// ---------- events ----------
const sessions = new Map(); // sessionId -> {conn, targetId|null (browser session)}
const draining = new Map();  // targetId -> promise
function attachedTo(targetId) { return [...sessions.entries()].filter(([, s]) => s.targetId === targetId); }
async function drain(targetId) {
  if (draining.has(targetId)) return draining.get(targetId);
  const run = (async () => {
    const p = owned.get(targetId); if (!p) return;
    let events;
    try { events = await p.events(); } catch (e) { await userControl(e); return; }
    if (!events?.length) return;
    const targets = attachedTo(targetId);
    for (const ev of events) {
      const method = ev.method ?? ev.name; if (!method) continue;
      // Child-target plumbing (OOPIF/workers) cannot be routed through a single page session.
      if (method.startsWith("Target.")) continue;
      for (const [sessionId, s] of targets) s.conn.send({ method, params: ev.params ?? {}, sessionId });
    }
  })().finally(() => draining.delete(targetId));
  draining.set(targetId, run);
  return run;
}
setInterval(() => { for (const id of new Set([...sessions.values()].map((s) => s.targetId).filter(Boolean))) drain(id).catch(() => {}); }, POLL_MS).unref?.();

// ---------- CDP dispatch ----------
function cdpError(code, message) { const e = Error(message); e.cdp = { code, message }; return e; }
const targetInfo = (t) => ({ targetId: t.targetId, type: t.type, title: t.title ?? "", url: t.url ?? "", attached: attachedTo(t.targetId).length > 0, canAccessOpener: false, browserContextId: "ego-default", ...(t.openerId ? { openerId: t.openerId } : {}) });
let userAgent = "Mozilla/5.0";
const BROWSER_NOOP = new Set(["Browser.setDownloadBehavior", "Browser.setWindowBounds", "Target.setDiscoverTargets", "Target.setRemoteLocations", "Browser.grantPermissions", "Browser.resetPermissions", "Target.activate", "Target.exposeDevToolsProtocol"]);
// Page-session commands Ego may refuse; answering {} keeps Playwright's attach sequence going.
const PAGE_OPTIONAL = new Set(["Log.enable", "Log.disable", "Console.enable", "Inspector.enable", "Performance.enable", "Security.enable", "Emulation.setFocusEmulationEnabled", "Page.setInterceptFileChooserDialog", "Page.setBypassCSP", "ServiceWorker.enable", "Debugger.setSkipAllPauses", "Audits.enable", "Security.setIgnoreCertificateErrors"]);

async function announce(conn, sessionOwner) {
  for (const t of await visibleTargets()) {
    if ([...sessions.values()].some((s) => s.conn === conn && s.targetId === t.targetId && s.parent === sessionOwner)) continue;
    const sessionId = crypto.randomUUID().replace(/-/g, "").toUpperCase();
    sessions.set(sessionId, { conn, targetId: t.targetId, parent: sessionOwner });
    conn.send({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { ...targetInfo(t), attached: true }, waitingForDebugger: false }, ...(sessionOwner ? { sessionId: sessionOwner } : {}) });
  }
}
function detachTarget(targetId) {
  for (const [sessionId, s] of sessions) if (s.targetId === targetId) {
    sessions.delete(sessionId);
    s.conn.send({ method: "Target.detachedFromTarget", params: { sessionId, targetId }, ...(s.parent ? { sessionId: s.parent } : {}) });
    s.conn.send({ method: "Target.targetDestroyed", params: { targetId } });
  }
}

async function browserCommand(conn, method, params, fromSession) {
  switch (method) {
    case "Browser.getVersion": return { protocolVersion: "1.3", product: "Chrome/ego-lite", revision: "", userAgent, jsVersion: "" };
    case "Target.getTargets": return { targetInfos: (await visibleTargets()).map(targetInfo) };
    case "Target.getTargetInfo": {
      if (!params.targetId) return { targetInfo: { targetId: state.instanceId, type: "browser", title: "", url: "", attached: true, canAccessOpener: false } };
      const t = (await visibleTargets()).find((x) => x.targetId === params.targetId); if (!t) throw cdpError(-32602, "No target with given id found"); return { targetInfo: targetInfo(t) };
    }
    case "Target.getBrowserContexts": return { browserContextIds: [] };
    case "Browser.getWindowForTarget": return { windowId: 1, bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: "normal" } };
    case "Target.setAutoAttach": { conn.autoAttach.add(fromSession ?? ""); if (params.autoAttach) await announce(conn, fromSession); return {}; }
    case "Target.attachToBrowserTarget": { const sessionId = crypto.randomUUID().replace(/-/g, "").toUpperCase(); sessions.set(sessionId, { conn, targetId: null }); return { sessionId }; }
    case "Target.attachToTarget": {
      const t = (await visibleTargets()).find((x) => x.targetId === params.targetId); if (!t) throw cdpError(-32602, "No target with given id found");
      await pageFor(t.targetId);
      const sessionId = crypto.randomUUID().replace(/-/g, "").toUpperCase();
      sessions.set(sessionId, { conn, targetId: t.targetId, parent: fromSession });
      conn.send({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { ...targetInfo(t), attached: true }, waitingForDebugger: false }, ...(fromSession ? { sessionId: fromSession } : {}) });
      return { sessionId };
    }
    case "Target.detachFromTarget": { const s = sessions.get(params.sessionId); if (s) { sessions.delete(params.sessionId); conn.send({ method: "Target.detachedFromTarget", params: { sessionId: params.sessionId, targetId: s.targetId }, ...(s.parent ? { sessionId: s.parent } : {}) }); } return {}; }
    case "Target.createTarget": {
      const targetId = await createPage(params.url);
      for (const c of connections) if (c.autoAttach.size) for (const owner of c.autoAttach) await announce(c, owner || undefined);
      return { targetId };
    }
    case "Target.closeTarget": { if (!(await visibleTargets()).some((t) => t.targetId === params.targetId)) throw cdpError(-32602, "No target with given id found"); return { success: await closePage(params.targetId) }; }
    case "Browser.close": return {};
  }
  if (BROWSER_NOOP.has(method)) return {};
  throw cdpError(-32601, `'${method}' wasn't found`);
}

const runtimeEnabled = new Set();
async function pageCommand(targetId, method, params) {
  const visible = await visibleTargets();
  if (!visible.some((t) => t.targetId === targetId && t.type === "page")) throw cdpError(-32001, "Session with given id not found");
  const p = await pageFor(targetId);
  switch (method) {
    case "Runtime.runIfWaitingForDebugger": return {};
    case "Target.setAutoAttach": return {};
    case "Target.getTargetInfo": return { targetInfo: targetInfo(visible.find((t) => t.targetId === targetId)) };
    case "Page.captureScreenshot": {
      // Raw captureScreenshot hangs on a background Ego tab; Ego's own screenshot handles it (PNG only).
      const file = path.join(STATE_DIR, "shots", `${crypto.randomUUID()}.png`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      try { await p.screenshot({ path: file, fullPage: !!params.captureBeyondViewport }); return { data: (await fs.readFile(file)).toString("base64") }; }
      catch (e) { if (await userControl(e)) throw cdpError(-32000, "SOURCE.BROWSER_USER_CONTROL"); throw cdpError(-32000, String(e?.message ?? e).slice(0, 500)); }
      finally { await fs.rm(file, { force: true }); }
    }
  }
  // A later client needs the existing execution contexts re-announced, as Chrome does per session.
  if (method === "Runtime.enable" && runtimeEnabled.has(targetId)) await p.cdp("Runtime.disable").catch(() => {});
  let result;
  try { result = await p.cdp(method, params); }
  catch (e) {
    if (await userControl(e)) throw cdpError(-32000, "SOURCE.BROWSER_USER_CONTROL");
    if (PAGE_OPTIONAL.has(method) && /not allowed|wasn't found|not found/i.test(String(e?.message))) return {};
    throw cdpError(-32000, String(e?.message ?? e).replace(/^Error: /, "").slice(0, 1000));
  }
  if (method === "Runtime.enable") runtimeEnabled.add(targetId);
  // Chrome sends the events a command caused before its response; drain now to keep that order.
  await drain(targetId);
  return result ?? {};
}

// ---------- minimal WebSocket server ----------
const connections = new Set();
function wsAccept(req, socket, onMessage) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0), parts = [], open = true;
  const frame = (op, payload) => {
    const n = payload.length; let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    socket.write(Buffer.concat([head, payload]));
  };
  const conn = { autoAttach: new Set(), send(obj) { if (open) frame(1, Buffer.from(JSON.stringify(obj))); }, close() { if (open) { open = false; try { frame(8, Buffer.alloc(0)); } catch {} socket.end(); } } };
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80; let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 64 * 1024 * 1024) { conn.close(); return; }
      const maskAt = off; if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[maskAt + (i & 3)];
      buf = buf.subarray(off + len);
      if (op === 8) { conn.close(); return; }
      if (op === 9) { frame(10, payload); continue; }
      if (op === 10) continue;
      parts.push(payload);
      if (fin) { const text = Buffer.concat(parts).toString("utf8"); parts = []; onMessage(conn, text); }
    }
  });
  const gone = () => { open = false; connections.delete(conn); for (const [id, s] of sessions) if (s.conn === conn) sessions.delete(id); };
  socket.on("close", gone); socket.on("error", gone);
  connections.add(conn);
  return conn;
}

function reply(conn, msg, result, error) {
  const out = { id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) };
  if (error) out.error = error.cdp ?? { code: -32000, message: String(error?.message ?? error).slice(0, 1000) }; else out.result = result;
  conn.send(out);
}
function onBrowserMessage(conn, text) {
  let msg; try { msg = JSON.parse(text); } catch { return; }
  (async () => {
    if (await exists(PAUSE_FILE)) throw cdpError(-32000, "SOURCE.BROWSER_USER_CONTROL");
    if (msg.sessionId) {
      const s = sessions.get(msg.sessionId);
      if (!s) throw cdpError(-32001, "Session with given id not found");
      if (s.targetId === null) return browserCommand(conn, msg.method, msg.params ?? {}, msg.sessionId);
      if (/^(Target|Browser)\./.test(msg.method) && !["Target.setAutoAttach", "Target.getTargetInfo"].includes(msg.method)) return browserCommand(conn, msg.method, msg.params ?? {}, msg.sessionId);
      return pageCommand(s.targetId, msg.method, msg.params ?? {});
    }
    return browserCommand(conn, msg.method, msg.params ?? {}, undefined);
  })().then((r) => reply(conn, msg, r), (e) => reply(conn, msg, undefined, e));
}
function onPageMessage(targetId) {
  return (conn, text) => {
    let msg; try { msg = JSON.parse(text); } catch { return; }
    (async () => { if (await exists(PAUSE_FILE)) throw cdpError(-32000, "SOURCE.BROWSER_USER_CONTROL"); return pageCommand(targetId, msg.method, msg.params ?? {}); })().then((r) => reply(conn, msg, r), (e) => reply(conn, msg, undefined, e));
  };
}

// ---------- HTTP ----------
const base = `127.0.0.1:${PORT}`;
const jsonTarget = (t) => ({ id: t.targetId, type: t.type, title: t.title ?? "", url: t.url ?? "", description: "", webSocketDebuggerUrl: `ws://${base}/devtools/page/${t.targetId}`, ...(t.openerId ? { openerId: t.openerId } : {}) });
const server = http.createServer((req, res) => {
  const send = (code, body) => { const data = typeof body === "string" ? body : JSON.stringify(body); res.writeHead(code, { "content-type": typeof body === "string" ? "text/plain" : "application/json; charset=UTF-8" }); res.end(data); };
  (async () => {
    if (req.headers.host !== base) return send(403, "host not allowed");
    const url = new URL(req.url, `http://${base}`);
    const p = url.pathname.replace(/\/$/, "");
    if (p === "/json/version") return send(200, { Browser: "Chrome/ego-lite", "Protocol-Version": "1.3", "User-Agent": userAgent, webSocketDebuggerUrl: `ws://${base}/devtools/browser/${state.instanceId}` });
    if (p === "/json" || p === "/json/list") return send(200, (await visibleTargets()).map(jsonTarget));
    if (p === "/json/new") {
      if (req.method !== "PUT") return send(405, "Using unsafe HTTP verb GET to invoke /json/new. This action supports only PUT verb.");
      const target = decodeURIComponent(url.search.slice(1)) || "about:blank";
      const id = await createPage(target);
      for (let n = 0; n < 50; n++) { const t = (await visibleTargets()).find((x) => x.targetId === id); if (t && (t.url === target || target === "about:blank")) return send(200, jsonTarget(t)); await new Promise((r) => setTimeout(r, 100)); }
      return send(200, jsonTarget((await visibleTargets()).find((x) => x.targetId === id) ?? { targetId: id, type: "page", url: "" }));
    }
    const close = /^\/json\/close\/([A-Za-z0-9-]{1,100})$/.exec(p);
    if (close) { if (!(await visibleTargets()).some((t) => t.targetId === close[1])) return send(404, `No such target id: ${close[1]}`); await closePage(close[1]); return send(200, "Target is closing"); }
    if (p === "/bridge/health") return send(200, { spaceId: task.spaceId, instanceId: state.instanceId, ownedPages: owned.size, sessions: sessions.size, connections: connections.size, paused: await exists(PAUSE_FILE) });
    return send(404, "not found");
  })().catch(async (e) => { await userControl(e); await log("http-error", { url: req.url, error: String(e?.message ?? e).slice(0, 300) }); if (!res.headersSent) send(500, String(e?.message ?? e).slice(0, 300)); });
});
server.on("upgrade", async (req, socket) => {
  try {
    if (req.headers.host !== base) { socket.destroy(); return; }
    const p = new URL(req.url, `http://${base}`).pathname;
    if (p === `/devtools/browser/${state.instanceId}`) { wsAccept(req, socket, onBrowserMessage); return; }
    const m = /^\/devtools\/page\/([A-Za-z0-9-]{1,100})$/.exec(p);
    if (m && (await visibleTargets()).some((t) => t.targetId === m[1] && t.type === "page")) { wsAccept(req, socket, onPageMessage(m[1])); return; }
    socket.destroy();
  } catch { socket.destroy(); }
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(PORT, "127.0.0.1", resolve); });
await log("listening", { endpoint: `http://${base}/`, webSocketDebuggerUrl: `ws://${base}/devtools/browser/${state.instanceId}` });

// Stop request: the bridge only stops serving. Owned pages stay; the DTC page journal decides their cleanup.
const STOP_FILE = path.join(STATE_DIR, "STOP");
await new Promise((resolve) => { const t = setInterval(async () => { if (await exists(STOP_FILE)) { clearInterval(t); resolve(); } }, 1000); });
await log("stop", { ownedPages: owned.size });
for (const c of connections) c.close();
await new Promise((resolve) => server.close(resolve));
// Consume the request last, so a remaining STOP file means this process did not finish stopping.
await fs.rename(STOP_FILE, `${STOP_FILE}.handled-${Date.now()}`);
await log("stopped");
process.exit(0);
