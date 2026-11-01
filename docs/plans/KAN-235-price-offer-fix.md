# KAN-235 取价修复短计划

1. 确认交付契约：`priceStatus` 只在 `extras.commerce` 中传输，交付价来自可空的 `commerce.price`；不改 Supply Smart。
2. Amazon 解析只接受主价或选中 Buy Box 的实付价。生鲜卖家或门店自提 Buy Box 标为 `other_offer`，价置空，把自提报价和门店文字保存在 commerce 证据中；补促销划线价选择器。
3. 首次原件归档并解析后，遇 `other_offer` 才以不同 `session_number` 再取一次。第二次也先归档并校验，再选用第二次结果；单个 capture 最多一次，失败不再重试。保留首次原件和最终原件的关联。
4. 用报告中的页面形态写相关解析与重抓单测，跑相关测试、仓库 typecheck 和 lint。只提交本分支，不部署。
