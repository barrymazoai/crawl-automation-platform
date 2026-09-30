# GNC Ego 页面采集与独立图片入口

## 已实现

`EgoRenderedBrowser` 在 `packages/v3-acquisition` 实现既有 `RenderedBrowser` 端口；GNC解析、R2可靠保存和独立回执模块不用重写。`gnc-product`/`gnc-catalog` 私有配置的 `browser` 可以显式选择Ego，旧CDP配置保持兼容。当前实机验收只涵盖613701单品，不代表目录抓取已验收。

```json
{
  "engine": "ego-lite",
  "sdk": "1",
  "cliPath": "/Users/barry/.local/bin/ego-browser",
  "taskSpaceId": 1,
  "targetId": "当前已授权标签的真实targetId",
  "sessionId": "本次会话标识"
}
```

这段替换原 `browser` 字段，完整角色配置仍需要原R2/Review/精确产品grant。配置文件必须私有。`network` 必须显式 `mode:host, managed:false`；此模式表示浏览器所在主机管理网络，**不声称固定出口、四Lane绑定或已核验公网IP**。输入binding与browser.sessionId/network.egressId仍须精确匹配。Ego和`nativeMouse`同时配置会在启动前被拒绝。

调用只读取已存在、已由协调者取得控制的精确标签；检查taskSpace、targetId、完整URL、readyState、浏览器真实responseStatus与2MiB上限。没有状态时拒绝，不补200。不会创建任务空间、新开标签、导航、鼠标输入、导出Cookie、抢回控制权或自动关闭页面。

Mini SDK1使用`useOrCreateTaskSpace/listTabs/switchTab/js`；SDK2使用`taskSpace/tabs/page.evaluate`，只操作已管理标签。SDK2仅隔离分支测试，未做MacBook实机采集验收。遇控制权拒绝应暂停协调者，不自动claim或重投。

CLI通过heredoc执行，快照写到传输层自己创建的私有临时文件，回传字节数/hash小回执；读取时校验权限、大小、哈希并拒绝符号链接。Mini旧SDK的`cliLog`实际走stderr，因此stdout/stderr都只接受精确前缀的一条回执；不打印完整HTML、Cookie或凭据。临时快照保留，R2证据也不删除。取消会停止本次CLI进程组，不关闭Ego。

## 验证

当前电脑只做类型检查/构建；测试在Mini。`build-ego-tests.ts` 生成隔离测试包，29项通过。`build-ego-capture.ts` 生成三个角色和独立验收入口：

```sh
node mini-ego-capture.js --authorized-ego-capture-one \
  /Users/barry/apps/crawlv3-ego-run.XXXXXX/live /绝对路径/browser.json
```

只允许新live目录、已批准613701；创建隔离Temporal namespace和PG，复用已有Mini认证及测试R2，三角色分别启动。成功后只读冷核验/历史重放，退出Worker并停止保留数据库；不操作用户页面生命周期。真实结果见[报告](../../docs/quality/2026-09-09-gnc-ego-worker.md)。旧核心原生入口未改作Ego入口，不直接使用。

## 独立图片 Worker

`gnc-file` 新增可选私有 `ego` 字段：

```json
{
  "ego": {
    "browser": { "engine": "ego-lite", "sdk": "1", "cliPath": "/绝对路径/ego-browser", "taskSpaceId": 1, "targetId": "当前真实targetId", "sessionId": "与来源binding一致" },
    "pageUrl": "https://www.gnc.com/energy/613701.html",
    "allowedUrls": ["从已发布产品计划解析的精确图片URL"]
  }
}
```

必须使用 `host` 网络、并发1，不得同时传 `proxyUrl`。所有产品grant的sessionId/pageUrl须匹配。资源仍由 `GncProductPlans.fileSource` 从已发布证据解析，精确URL还须在transport白名单内，不能把Workflow传来的任意URL直接请求。资源headers必须为空：浏览器使用同源会话，不导出或导入Cookie。

`EgoFileTransport` 在原产品标签页发单图GET，`redirect:error`、CORS约束、不导航、不重试、不Canvas重编码。DNS/TLS归浏览器所在主机；这不是应用层公网地址固定，也不证明实际出口。只增加受信transport的 `targetResolution:browser`，原direct仍强制公网DNS固定，未对任意任务关闭SSRF检查。部署者仍负责浏览器出口/解析限制。

此版本每图最大4MiB（私有JSON/原始字节回执上限），小于通用下载32MiB；超过明确失败，不静默截断。Fetch返回HTTP解码后的实体字节，响应头长度按交付字节记，不冒用压缩前wire长度；图片像素不缩放、不压缩。URL自带的CDN尺寸参数原样保留，不因此声称最大原图。

同空间必须由协调者独占；当前一次受限验收由单file进程、并发1和已停止的采集进程保证，无跨进程自动租约。取消停止本次CLI，浏览器GET内另有25秒AbortController；不关闭页面或自动夺回控制。用户控制拒绝保留 `SOURCE.BROWSER_USER_CONTROL`，协调者停止，不当普通网络失败继续调别的接口。

`build-ego-files.ts` 生成独立文件Worker及**仅验收用**的逐文件Workflow入口。`mini-ego-files.ts` 只接受新运行目录，复用已存613701采集，显式生成新产品计划、4个单文件Workflow，不调OCR/模型，不写旧生产库。当前固定指向已知隔离验收容器/捕获，不能当常驻通用部署命令。

## 后续边界

图片host端口已接入；未配置拥有者客户端的host仍拒绝，旧direct/static-proxy不变。图片可靠保存不等同完整产品入库。后续从本轮已发布文件继续核心准备、OCR关键词、Luna/medium提取、汇合保存。常驻服务、跨进程会话独占租约、批量Brand与Web派发未发布；隔离namespace和单Worker不等同生产并发租约方案。
