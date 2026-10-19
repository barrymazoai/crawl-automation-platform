# 服务可用性监控（Mac mini → 飞书「Supply Smart 服务通知」群）

用户 2026-10-19 要求：Server 一、Server 二、Windows 任何一台关机、断网或关键服务挂了，第一时间发到飞书群。
纯脚本（Python 标准库），不用模型、不用 Codex。

## 在哪里跑

| 项目 | 位置 |
|---|---|
| 机器 | Mac mini `barry@192.168.0.25`（`barrydeMac-mini.local`，就是发爬虫群通知的那台） |
| 代码 | `~/apps/service-monitor`（本仓库 sparse clone，只检出 `ops/service-monitor`） |
| 脚本 | `ops/service-monitor/service_monitor.py`，系统自带 `/usr/bin/python3`（3.9） |
| 定时 | LaunchAgent `com.barry.notify.service-monitor`（`~/Library/LaunchAgents/`） |
| webhook | `~/notify/crawler.webhook`（和爬虫通知共用，600 权限，不进 git、不打印） |
| 状态 | `~/notify/state/service-monitor.json` |
| 日志 | `~/notify/logs/service-monitor.log`（每轮一行 JSON 摘要） |
| 覆盖配置（可选） | `~/notify/service-monitor.json` |

和同机已有的 `~/notify/crawler_notify.py`（爬虫进度 / 爬虫告警）互相独立：不同状态文件、不同 launchd 任务，
用同一个 webhook 和同样的卡片格式。爬虫告警里也有"机器不在线"，两边都会报；爬虫通知以后挪到 Server 一，
机器层面的监控以这里为准。

## 查什么

| 机器 | 检查项 | 怎么查 |
|---|---|---|
| Server 一 | 机器在线 | Mac mini 连 `100.76.126.12:22`；不通再 `tailscale ping`，区分"关机/断网"和"只是 SSH 不通" |
| | 远程登录 | `ssh server@100.76.126.12`（BatchMode），下面几项在一次 SSH 里查完 |
| | 产品数据库 | `docker exec crawler-v3-us-postgres-1 pg_isready` |
| | 爬虫 API | `curl 127.0.0.1:4188/health` 返回 `{"ok":true}` |
| | 队列 / Worker | `pm2 jlist`（`PM2_HOME=~/apps/crawler-v3/pm2`）全部 `online` |
| | 数据盘 | `/System/Volumes/Data` 已用 < 90%（10-19 曾写到 96% 导致全部资源不健康） |
| Server 二 | 机器在线、远程登录 | 同上，`server2@100.84.91.3` |
| | Temporal 容器 | `crawler-temporal-local-{temporal,gateway,postgres}-1` 都是 `running/healthy` |
| | Temporal 7233 | **从 Server 一** 连 `192.168.68.76:7233`（Worker 实际走的路径；地址取自 Server 一 worker 配置） |
| | Temporal 管理页 | Mac mini 请求 `http://100.84.91.3:8080/`，有 HTTP 响应且 < 500 就算正常（有密码，401 正常） |
| | 数据盘 | 同上 |
| Windows | 机器在线 | `100.114.3.97:22` + `tailscale ping` |
| | OCR（Tailscale） | Mac mini 请求 `http://100.114.3.97:8081/health`：`status=ok` 且 `healthy_backends == total_backends > 0` |
| | OCR（局域网） | **从 Server 一** 请求 `http://192.168.68.74:8081/health`（爬虫实际用的地址；10-18 portproxy 故障就是这条断的） |

注意：Mac mini 开着 Clash 系统代理，脚本访问内网 / Tailscale 地址时显式不走代理（否则代理回 502）；发飞书照常走系统设置。

## 什么时候发消息

- **每 4 小时一轮**：北京时间 00、04、08、12、16、20 点整。
- **报警**：某项失败时当场隔 2 分钟重试，共重试 2 次（约 4 分钟），还失败就发红色「服务告警」，
  写明机器、哪一项、失败原因、首次发现时间和已持续多久。重试期间恢复的只记日志，不发消息。
- **不刷屏**：同一个问题报过一次后，持续失败不再重复发；没发出去（飞书或网络失败）的下一轮补发。
- **整机不在线**：只报"机器在线"这一条，这台机器的其他项本轮当作未知，不单独报。
- **恢复**：之前报过的问题，下一轮检查通过就发绿色「服务恢复」，写明持续了多久。
- **心跳**：每天 08:00 那一轮之后发一条「服务心跳」：全部正常是绿色；有未恢复问题是橙色并列出来。
  **哪天早上没收到心跳，说明 Mac mini 自己出了问题**（关机、断网、没登录、launchd 没跑）。

## 安装 / 更新（在 Mac mini 上）

代码只走 git，不拷文件：

```sh
# 首次
git clone --depth 1 --filter=blob:none --sparse -b ops/service-health-monitor \
  git@github.com-mazoai:barrymazoai/crawl-automation-platform.git ~/apps/service-monitor
git -C ~/apps/service-monitor sparse-checkout set ops/service-monitor
cp ~/apps/service-monitor/ops/service-monitor/com.barry.notify.service-monitor.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.barry.notify.service-monitor.plist

# 更新代码（合进 main 后把 -b 换成 main，或 git switch main）
git -C ~/apps/service-monitor pull --ff-only
```

只改了脚本不用重载 launchd，下一轮自动用新代码；改了 plist 要先 `bootout` 再 `bootstrap`。

**重启后**：LaunchAgent 在用户 `barry` 登录后自动加载。这台机器开着 FileVault、没有自动登录，
重启后需要有人登录一次（和现有爬虫通知一样）；没登录前不会检查也不会发心跳。

## 手动运行

```sh
cd ~/apps/service-monitor/ops/service-monitor
/usr/bin/python3 service_monitor.py status          # 只看当前结果：不重试、不发消息、不改状态
/usr/bin/python3 service_monitor.py check --dry     # 完整一轮（含重试），消息只打印
/usr/bin/python3 service_monitor.py check           # 和定时任务完全一样
launchctl kickstart gui/$(id -u)/com.barry.notify.service-monitor   # 让 launchd 立刻跑一轮
```

## 怎么停

```sh
launchctl bootout gui/$(id -u)/com.barry.notify.service-monitor   # 立刻停，重启前不再跑
```

要永久停，再把 `~/Library/LaunchAgents/com.barry.notify.service-monitor.plist` 移走（删除由用户自己执行）。
停掉不影响任何服务器，也不影响爬虫通知。

## 怎么改

- **频率**：改 plist 的 `StartCalendarInterval`，`bootout` + `bootstrap` 重载；心跳文案里的"每 4 小时"一起改。
- **地址、阈值、重试**：写 `~/notify/service-monitor.json`（只写要改的键），例如
  ```json
  {"retry_wait_seconds": 120, "retries": 2, "heartbeat_hour": 8, "disk_alert_percent": 90,
   "server2": {"temporal_lan": "192.168.68.76:7233"},
   "windows": {"ocr_health_lan": "http://192.168.68.74:8081/health"}}
  ```
  可改的键见脚本里的 `DEFAULTS`。局域网地址是 DHCP 观测值，换了 IP（10-17 就换过）记得同步这里和 worker 配置。
- **临时模拟**：环境变量 `SERVICE_MONITOR_OVERRIDE` 接受同样的 JSON，只对这一次运行生效，例如把 OCR 地址改错测报警：
  `SERVICE_MONITOR_OVERRIDE='{"windows":{"ocr_health":"http://100.114.3.97:8099/health"}}' /usr/bin/python3 service_monitor.py check`
- **加检查项**：在 `CHECKS` 加名字，在对应机器的远程脚本或 `group_*` 函数里输出结果。

## 验证记录

见本文末尾"2026-10-19 安装验证"。
