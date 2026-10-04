# 目录方法文件生成职责

CRAWLV3-199，关联 147/151。Jarrow scan `16d8f89e-71a4-4d94-b3cb-c986be79ec3a` 在
`99c716d` 上完成预检，模型生成的 setup-preflight.mjs 先保存公共 profile，再手写
`capture/catalog-method-profile.json`。正式 run-capture.mjs 只调用一次 discoverCatalog，
但该入口内部 retainCatalogProfile 也不可覆盖地创建同一文件，所以在 ENUMERATE 开始前
报 EEXIST。02:20:42Z 终态 DTC.CAPTURE_REVIEW，未发现商品；不是网站没有商品或分页卡住。

通用提示要求模型“将本次采用的方法 profile 副本存到 outDir”，与后来入口自动留存规则
叠加。修正为：catalog 模式读取旧方法并传入经观察验证后的参数，由 discoverCatalog
统一保存公共 profile、方法副本及散列回执；模型的采前记录使用 route-plan.json 或
preflight-method.json，不提前写引擎文件或调用其内部留存函数。同步原生采集 skill 说明。
不增加重新解析、预审、品牌专用条件，不改原件不可覆盖或单次业务采集约束。

旧任务 26 原件 / 4,644,255 字节 R2 全量大小和 SHA 校验通过，1 Workflow / 1 许可 /
4 执行停止审计 invalid=[]；证明存于 Server 一 dtc-native-20261002 的
`catalog-16d8f89e-71a4-4d94-b3cb-c986be79ec3a-{r2,stop}-proof.json`。
原失败不重试或覆盖。必要静态检查 pnpm check 通过，无单元测试；部署与 Mini 新任务验证待追加。
