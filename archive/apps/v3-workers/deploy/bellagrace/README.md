# 当前 DTC 对照站点：Bella Grace

入口为 https://shopbellagrace.com/collections/wellness，范围仅限该分类。公开配置见 deployment.json，Windows 操作见 WINDOWS_SWITCH_PROMPT.md。

复用 D:\crawlv3-dtc-v2 和原 queueScope/nodeId；编号中的 innerbody 是既有部署标识，不代表当前品牌。scope/site 指向 Bella Grace，R2 evidencePrefix 单独使用 dtc-bellagrace-wellness-20260912。

2026-09-12 Mini 预检观察 7 个商品链接；分类接口第一页返回同样 7 项、第二页为空。源码补上分类目录自身的结束证明，并继续接受旧 all-products 证明。预检不能替代实际商品、图库和标签采集。

Mini 配套切换后，Windows 必须完成本目录 Prompt 中的更新和站点设置替换。两端同步前不提交采集。Innerbody 目录中的旧部署说明作为历史记录保留，不应用于本次切换。
