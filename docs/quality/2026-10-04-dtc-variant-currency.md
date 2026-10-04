# 网站规格币种传递

CRAWLV3-193，关联184/155/151。审计真实Solaray材料时发现旧normalizePlatformVariants
保留了price，但未传递网站明确给出的price_currency。run
`d45fe3e0-b54a-4a2b-bb99-a732c06d0bb6`两规格原件均含USD，capture fields.currency
却为空，variants也没有currency。该任务2/2业务成功不代表币种保留完整。

原始响应SHA-256：`f8bca8a846fbdb772a6983c1b5144cd1f86f8e429badd146e04a646b1b3a6e92`。
两个variant为39660429836348（31.99 USD）和39660429803580（18.39 USD）。
原件未提供available，因此本次不能宣称库存完整，缺货选项验证仍归155。

修复只将已有variant.price_currency传为currency，空值不补默认币种；不解析产品正文，
不改变原件或旧Review。当前Tongkat首次采集继续在ab3d62c运行，修复待其结束后Git部署。
只做必要静态检查与Mini留存原件直接验证，不新增或运行单元测试。结果待追加。
