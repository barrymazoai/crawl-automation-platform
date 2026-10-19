#!/usr/bin/env python3
"""服务可用性监控 → 飞书「Supply Smart 服务通知」群（纯脚本，不用模型）。

在 Mac mini（barry@192.168.0.25）上由 launchd 每 4 小时运行一次，检查 Server 一、Server 二、
Windows 三台机器是否在线、关键服务是否可用：

  service_monitor.py check    跑一轮检查；某项失败就隔 2 分钟重试 2 次，仍失败才报警；
                              之前报过的问题这轮通过了就报恢复。每天第一轮到点后附带一条心跳。
  service_monitor.py status   只打印当前检查结果，不重试、不发消息、不改状态
  加 --dry                     检查和重试照常，但消息只打印不发送，也不写状态

地址、阈值、重试间隔可以用 ~/notify/service-monitor.json 覆盖（见 DEFAULTS），不用改代码。
说明见 docs/operations/service-health-monitor.md。
"""
import datetime, fcntl, json, os, socket, subprocess, sys, time, urllib.request

HOME = os.path.expanduser("~")
NOTIFY = os.path.join(HOME, "notify")
DEFAULTS = {
    "webhook_file": os.path.join(NOTIFY, "crawler.webhook"),
    "state_file": os.path.join(NOTIFY, "state", "service-monitor.json"),
    "tailscale": "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "retries": 2,                 # 失败后当场重试的次数
    "retry_wait_seconds": 120,    # 每次重试前等多久
    "heartbeat_hour": 8,          # 每天几点（本机时间，北京）之后的第一轮发心跳
    "disk_alert_percent": 90,     # 数据盘用到多少报警
    "server1": {"ssh": "server@100.76.126.12", "ip": "100.76.126.12",
                "postgres_container": "crawler-v3-us-postgres-1",
                "api_health": "http://127.0.0.1:4188/health",
                "pm2_home": "~/apps/crawler-v3/pm2",
                "node_bin": "/Users/server/Applications/Crawler Node.app/Contents/bin"},
    "server2": {"ssh": "server2@100.84.91.3", "ip": "100.84.91.3",
                "temporal_containers": ["crawler-temporal-local-temporal-1",
                                        "crawler-temporal-local-gateway-1",
                                        "crawler-temporal-local-postgres-1"],
                "temporal_lan": "192.168.68.76:7233",
                "temporal_ui": "http://100.84.91.3:8080/"},
    "windows": {"ip": "100.114.3.97",
                "ocr_health": "http://100.114.3.97:8081/health",
                "ocr_health_lan": "http://192.168.68.74:8081/health"},
}

# 检查项：key → (机器, 项目)。报警、恢复、心跳都按这里的名字显示。
CHECKS = {
    "s1.host": ("Server 一", "机器在线（SSH 端口）"),
    "s1.ssh": ("Server 一", "远程登录检查（SSH）"),
    "s1.postgres": ("Server 一", "产品数据库 Postgres"),
    "s1.api": ("Server 一", "爬虫 API 4188"),
    "s1.pm2": ("Server 一", "队列 / Worker 进程（pm2）"),
    "s1.disk": ("Server 一", "数据盘空间"),
    "s2.host": ("Server 二", "机器在线（SSH 端口）"),
    "s2.ssh": ("Server 二", "远程登录检查（SSH）"),
    "s2.temporal": ("Server 二", "Temporal 容器健康"),
    "s2.temporal_lan": ("Server 二", "Temporal 7233（Server 一 局域网直连）"),
    "s2.temporal_ui": ("Server 二", "Temporal 管理页 8080"),
    "s2.disk": ("Server 二", "数据盘空间"),
    "win.host": ("Windows", "机器在线（SSH 端口）"),
    "win.ocr": ("Windows", "OCR 8081 健康检查"),
    "win.ocr_lan": ("Windows", "OCR 8081（Server 一 局域网直连）"),
}

DRY = "--dry" in sys.argv


def load_config():
    """默认值 ← ~/notify/service-monitor.json ← 环境变量 SERVICE_MONITOR_OVERRIDE（JSON，临时测试用）。"""
    cfg = json.loads(json.dumps(DEFAULTS))
    overrides = []
    try:
        overrides.append(json.load(open(os.path.join(NOTIFY, "service-monitor.json"))))
    except FileNotFoundError:
        pass
    if os.environ.get("SERVICE_MONITOR_OVERRIDE"):
        overrides.append(json.loads(os.environ["SERVICE_MONITOR_OVERRIDE"]))
    for override in overrides:
        for k, v in override.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    return cfg


CFG = load_config()


def now():
    return datetime.datetime.now().replace(microsecond=0)


def ago(since):
    minutes = int((now() - datetime.datetime.fromisoformat(since)).total_seconds() // 60)
    if minutes < 60:
        return f"{max(minutes, 1)} 分钟"
    hours, minutes = divmod(minutes, 60)
    if hours < 48:
        return f"{hours} 小时" + (f" {minutes} 分钟" if minutes else "")
    return f"{hours // 24} 天 {hours % 24} 小时"


def hm(iso):
    return datetime.datetime.fromisoformat(iso).strftime("%m-%d %H:%M")


# ---------- 发消息：和 ~/notify/send.py 相同的卡片格式 ----------

def send(title, md, color):
    if DRY:
        print(f"[{color}] {title}\n{md}\n")
        return True
    hook = open(CFG["webhook_file"]).read().strip()
    card = {
        "schema": "2.0",
        "header": {"title": {"tag": "plain_text", "content": title}, "template": color},
        "body": {"elements": [{"tag": "markdown", "content": md.strip() or "(空)"}]},
    }
    req = urllib.request.Request(hook, json.dumps({"msg_type": "interactive", "card": card}).encode(),
                                 {"Content-Type": "application/json"})
    try:
        resp = json.load(urllib.request.urlopen(req, timeout=30))
    except Exception as e:
        log(f"发送失败：{e}")
        return False
    if resp.get("code") != 0:
        log(f"飞书拒收：code={resp.get('code')} msg={resp.get('msg')}")
        return False
    return True


def log(msg):
    print(f"{now().isoformat()} {msg}", flush=True)


# ---------- 检查 ----------

def tcp_open(ip, port, timeout=10):
    try:
        socket.create_connection((ip, port), timeout=timeout).close()
        return True
    except OSError:
        return False


def host_check(ip):
    """SSH 端口通就算在线；不通时再用 Tailscale ping 区分“关机/断网”和“只是 SSH 不通”。"""
    if tcp_open(ip, 22):
        return True, "SSH 端口可连"
    try:
        r = subprocess.run([CFG["tailscale"], "ping", "-c", "1", "--timeout", "10s", ip],
                           capture_output=True, text=True, timeout=30)
        pong = r.returncode == 0
    except Exception:
        pong = False
    return False, ("SSH 端口不通，但 Tailscale ping 得通（sshd 或防火墙问题）" if pong
                   else "SSH 端口和 Tailscale ping 都不通（关机或断网）")


# Mac mini 开着 Clash 系统代理；内网 / Tailscale 地址必须直连，否则代理会回 502
DIRECT = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_get(url, timeout=15):
    """返回 (状态码, 正文)；连不上返回 (None, 错误)。"""
    try:
        with DIRECT.open(url, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return None, str(e)


def ocr_result(code, body):
    if code != 200:
        return False, f"HTTP {code}" if code else f"连不上 {body}".strip()[:200]
    try:
        h = json.loads(body)
    except ValueError:
        return False, "返回的不是 JSON"
    good, total = h.get("healthy_backends", 0), h.get("total_backends", 0)
    ok = h.get("status") == "ok" and total > 0 and good == total
    return ok, f"status={h.get('status')}，后端 {good}/{total}"


# 远程脚本逐行输出：key<TAB>ok|fail<TAB>说明；OCR 输出 key<TAB>ocr<TAB>状态码<TAB>正文，在本机判断。
SERVER1_SCRIPT = r'''
export PATH="$NODE_BIN:$PATH:$HOME/.local/bin:$HOME/.docker/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" PM2_HOME="${PM2_HOME/#\~/$HOME}"
r() { printf '%s\t%s\t%s\n' "$1" "$2" "$(printf '%s' "$3" | tr '\t\n' '  ' | cut -c1-300)"; }
out=$(docker exec "$PG" pg_isready -h 127.0.0.1 -p 5432 2>&1) && r s1.postgres ok "$out" || r s1.postgres fail "$out"
out=$(curl -s -m 15 "$API" 2>&1)
case "$out" in *'"ok":true'*) r s1.api ok "$out" ;; *) r s1.api fail "/health 返回：${out:-无响应}" ;; esac
out=$(pm2 jlist 2>/dev/null | python3 -c 'import json,sys
ps = json.load(sys.stdin)
bad = [p["name"] + "=" + p["pm2_env"]["status"] for p in ps if p["pm2_env"]["status"] != "online"]
print(("fail\t" if bad or not ps else "ok\t") + (("不在线：" + "、".join(bad)) if bad else "%d 个进程在线" % len(ps) if ps else "pm2 没有进程"))' 2>&1)
case "$out" in ok*|fail*) printf 's1.pm2\t%s\n' "$out" ;; *) r s1.pm2 fail "读不到 pm2：$out" ;; esac
pct=$(df -P -k /System/Volumes/Data | awk 'NR==2{sub("%","",$5); print $5}')
[ "$pct" -lt "$DISK" ] 2>/dev/null && r s1.disk ok "已用 $pct%" || r s1.disk fail "已用 ${pct:-?}%（阈值 $DISK%）"
nc -z -G 10 "${TEMPORAL%:*}" "${TEMPORAL##*:}" >/dev/null 2>&1 && r s2.temporal_lan ok "$TEMPORAL 可连" || r s2.temporal_lan fail "Server 一 连不上 $TEMPORAL"
out=$(curl -s -m 15 -w '\n%{http_code}' "$OCR_LAN")
printf 'win.ocr_lan\tocr\t%s\t%s\n' "${out##*$'\n'}" "$(printf '%s' "${out%$'\n'*}" | tr '\t\n' '  ')"
'''

SERVER2_SCRIPT = r'''
export PATH="$PATH:$HOME/.docker/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
r() { printf '%s\t%s\t%s\n' "$1" "$2" "$(printf '%s' "$3" | tr '\t\n' '  ' | cut -c1-300)"; }
bad=""
for c in $CONTAINERS; do
  s=$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}healthy{{end}}' "$c" 2>&1)
  [ "$s" = "running/healthy" ] || bad="$bad $c=$s"
done
[ -z "$bad" ] && r s2.temporal ok "容器都 healthy" || r s2.temporal fail "异常：$bad"
pct=$(df -P -k /System/Volumes/Data | awk 'NR==2{sub("%","",$5); print $5}')
[ "$pct" -lt "$DISK" ] 2>/dev/null && r s2.disk ok "已用 $pct%" || r s2.disk fail "已用 ${pct:-?}%（阈值 $DISK%）"
'''


def remote(ssh_key, target, script, env):
    """在远端跑脚本，返回 {key: (ok, 说明)}。SSH 本身失败时只返回 ssh 这一项。"""
    exports = "".join(f"{k}={shell_quote(v)} " for k, v in env.items())
    try:
        r = subprocess.run(["ssh", "-o", "ConnectTimeout=15", "-o", "BatchMode=yes", target,
                            f"{exports}bash -s"], input=script, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return {ssh_key: (False, "远程检查超过 120 秒没结束")}
    out = {}
    for line in r.stdout.splitlines():
        parts = line.split("\t", 3)
        if len(parts) >= 3 and parts[0] in CHECKS:
            if parts[1] == "ocr":
                code = int(parts[2]) if parts[2].isdigit() and parts[2] != "000" else None
                out[parts[0]] = ocr_result(code, parts[3] if len(parts) > 3 else "连不上")
            else:
                out[parts[0]] = (parts[1] == "ok", "\t".join(parts[2:]))
    if not out:
        return {ssh_key: (False, f"SSH 退出码 {r.returncode}：{(r.stderr or r.stdout).strip()[:200]}")}
    out[ssh_key] = (True, "SSH 登录正常")
    return out


def shell_quote(v):
    return "'" + str(v).replace("'", "'\\''") + "'"


def group_server1():
    s1, s2, win = CFG["server1"], CFG["server2"], CFG["windows"]
    up, why = host_check(s1["ip"])
    if not up:
        return {"s1.host": (False, why)}
    return {"s1.host": (True, why), **remote("s1.ssh", s1["ssh"], SERVER1_SCRIPT, {
        "NODE_BIN": s1["node_bin"], "PM2_HOME": s1["pm2_home"],
        "PG": s1["postgres_container"], "API": s1["api_health"], "DISK": CFG["disk_alert_percent"],
        "TEMPORAL": s2["temporal_lan"], "OCR_LAN": win["ocr_health_lan"]})}


def group_server2():
    s2 = CFG["server2"]
    up, why = host_check(s2["ip"])
    if not up:
        return {"s2.host": (False, why)}
    code, body = http_get(s2["temporal_ui"])
    ui = (code is not None and code < 500,
          f"HTTP {code}（有密码保护，401 也算正常）" if code else f"连不上：{body}"[:200])
    return {"s2.host": (True, why), "s2.temporal_ui": ui, **remote("s2.ssh", s2["ssh"], SERVER2_SCRIPT, {
        "CONTAINERS": " ".join(s2["temporal_containers"]), "DISK": CFG["disk_alert_percent"]})}


def group_windows():
    win = CFG["windows"]
    up, why = host_check(win["ip"])
    return {"win.host": (up, why), "win.ocr": ocr_result(*http_get(win["ocr_health"]))}


GROUPS = {"s1": group_server1, "s2": group_server2, "win": group_windows}
# 哪个组负责哪些 key（win.ocr_lan、s2.temporal_lan 从 Server 一 测，跟着 s1 组重跑）
OWNER = {k: ("s1" if k in ("win.ocr_lan", "s2.temporal_lan") else k.split(".")[0]) for k in CHECKS}


def run_groups(names):
    results = {}
    for name in names:
        try:
            results.update(GROUPS[name]())
        except Exception as e:  # 监控自己出错也要报出来，不能静默
            results[f"{name}.host"] = (False, f"监控脚本出错：{e!r}"[:300])
    return results


def check_with_retries():
    """跑一轮；失败的项隔 retry_wait_seconds 重跑所在组，最多 retries 次。返回 (结果, 首次失败时间)。"""
    started = now().isoformat()
    results = run_groups(GROUPS)
    first_fail = {k: started for k, (ok, _) in results.items() if not ok}
    for attempt in range(1, CFG["retries"] + 1):
        failing = [k for k, (ok, _) in results.items() if not ok]
        if not failing:
            break
        log(f"第 {attempt} 次重试前等待 {CFG['retry_wait_seconds']} 秒，失败项：{', '.join(failing)}")
        time.sleep(CFG["retry_wait_seconds"])
        again = run_groups(sorted({OWNER[k] for k in failing}))
        for k in failing:
            if k in again:
                results[k] = again[k]
            else:
                results.pop(k)  # 这次没测到（比如上一层恢复了但下一层没跑），本轮当作未知
        for k, (ok, _) in again.items():  # 重跑组里新冒出来的失败项（比如 SSH 通了但服务挂了）
            if k not in results:
                results[k] = again[k]
            if not results[k][0]:
                first_fail.setdefault(k, now().isoformat())
    # 整台机器不在线时，这台机器的其他项不单独报（结果当作未知），免得一次停机刷一串
    down = {CHECKS[k][0] for k, (ok, _) in results.items() if k.endswith(".host") and not ok}
    results = {k: v for k, v in results.items() if k.endswith(".host") or CHECKS[k][0] not in down}
    return results, first_fail


# ---------- 状态与通知 ----------

def load_state():
    try:
        return json.load(open(CFG["state_file"]))
    except Exception:
        return {"problems": {}}


def save_state(state):
    if DRY:
        return
    os.makedirs(os.path.dirname(CFG["state_file"]), exist_ok=True)
    tmp = CFG["state_file"] + ".tmp"
    json.dump(state, open(tmp, "w"), ensure_ascii=False, indent=1)
    os.replace(tmp, CFG["state_file"])


def label(k):
    machine, item = CHECKS[k]
    return f"**{machine}** · {item}"


def check():
    if not DRY:  # 手动跑和定时跑撞在一起时排队，不并发改状态
        os.makedirs(os.path.dirname(CFG["state_file"]), exist_ok=True)
        lock = open(CFG["state_file"] + ".lock", "w")
        fcntl.flock(lock, fcntl.LOCK_EX)
    state = load_state()
    problems = state.setdefault("problems", {})
    previous_run = state.get("last_run")
    results, first_fail = check_with_retries()
    tries = CFG["retries"] + 1

    alert_lines, alerted_now, recovered_lines = [], [], []
    for k, (ok, detail) in results.items():
        p = problems.get(k)
        if not ok:
            if p is None:
                p = problems[k] = {"since": first_fail.get(k, now().isoformat()), "alerted": False}
            p["detail"] = detail
            if not p["alerted"]:  # 新问题，或上次报警没发出去
                prev = f"上一轮 {hm(previous_run)} 正常；" if previous_run and k not in state.get("failing_last_run", []) else ""
                alerted_now.append(k)
                alert_lines.append(f"- 🔴 {label(k)}：{detail}\n  <font color='grey'>{prev}"
                                   f"{hm(p['since'])} 发现，连试 {tries} 次都失败，已持续 {ago(p['since'])}</font>")
        elif p is not None:
            if p["alerted"]:
                recovered_lines.append(f"- ✅ {label(k)} 已恢复\n  <font color='grey'>{hm(p['since'])} 发现，"
                                       f"持续约 {ago(p['since'])}</font>")
            del problems[k]

    if alert_lines:
        earlier = sum(1 for p in problems.values() if p["alerted"])
        tail = f"\n\n另有 {earlier} 项之前报过、仍未恢复。" if earlier else ""
        if send(f"服务告警 {now():%m-%d %H:%M}", "\n".join(alert_lines) + tail, "red"):
            for k in alerted_now:
                problems[k]["alerted"] = True
    if recovered_lines:
        still = sum(1 for p in problems.values() if p["alerted"])
        tail = f"\n\n仍有 {still} 项未恢复。" if still else "\n\n目前全部正常。"
        if not send(f"服务恢复 {now():%m-%d %H:%M}", "\n".join(recovered_lines) + tail, "green"):
            log("恢复消息没发出去（问题已从状态里移除，不再重发）")

    state["last_run"] = now().isoformat()
    state["failing_last_run"] = [k for k, (ok, _) in results.items() if not ok]
    state["last_results"] = {k: {"ok": ok, "detail": d} for k, (ok, d) in results.items()}
    heartbeat(state, results)
    save_state(state)
    log(json.dumps({"failing": state["failing_last_run"], "open": sorted(problems),
                    "alerts": len(alert_lines), "recoveries": len(recovered_lines)}, ensure_ascii=False))


def heartbeat(state, results):
    """每天 heartbeat_hour 点之后的第一轮发一条。没收到心跳 = Mac mini 自己出了问题。"""
    today = now().date().isoformat()
    if now().hour < CFG["heartbeat_hour"] or state.get("heartbeat_date") == today:
        return
    problems = state["problems"]
    if not problems:
        md = (f"**全部正常**：{len(results)} 项检查都通过（Server 一、Server 二、Windows）。\n\n"
              f"<font color='grey'>每 4 小时检查一次；哪天没收到这条，说明发通知的 Mac mini 本身出了问题。</font>")
        color = "green"
    else:
        normal = sum(1 for ok, _ in results.values() if ok)
        md = "\n".join([f"**{len(problems)} 项异常**，{normal} 项正常："] +
                       [f"- 🔴 {label(k)}：{p.get('detail', '')}（{hm(p['since'])} 起，已 {ago(p['since'])}）"
                        for k, p in problems.items()])
        color = "orange"
    if send(f"服务心跳 {now():%m-%d %H:%M}", md, color):
        state["heartbeat_date"] = today


def status():
    results = run_groups(GROUPS)
    for k in CHECKS:
        if k in results:
            ok, detail = results[k]
            print(f"{'OK  ' if ok else 'FAIL'} {CHECKS[k][0]} · {CHECKS[k][1]}：{detail}")
        else:
            print(f"--   {CHECKS[k][0]} · {CHECKS[k][1]}：未检查（上一层不通）")


if __name__ == "__main__":
    {"check": check, "status": status}[sys.argv[1]]()
