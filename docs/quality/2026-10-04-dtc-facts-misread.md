# 留存 Facts 成分误读核实

CRAWLV3-196/197，关联 184/151。本轮没有再次请求 OCR、模型或产品网页。
Nature’s Truth Ashwagandha `b5d2ad49-6337-425d-8d0e-a06523c8df9e` 的下游自动 collected
不能等同准确性通过：原图 Other Ingredients 首项是 Glucose Syrup，保存的 Vision 候选
`otherIngredients.items[0]` 的 text/evidence 已是 Gluten，后续 collected-product 原样保留。
这不是转换阶段把正确字段替换，也不是采集阶段重复解析业务数据。

图片 SHA 为 `5e1c1ba421e0713eaef4b2f8a82645986c306c0b800b84ab0605fc54c6cd6482`，
49,378 字节、375×500；Vision 记录
`v3/vision/chl-78ae57b4bc4b40d3b52e17f0f91bc9d1501158c74cf0fa9c9ee3621e18245479/response.json`。
既有 OCR 做 Facts 候选选择校验，视觉读取这张原图字节。原结果和证据保持不变。

02:31Z 在 Mini 留存 `materials/page-initial.html` 核实：实际图库 img 有 data-zoom URL，
参数 width=1800、height=2400；src/srcset 最大 375×500，img 没有外层 a。
保存的 site-method.mjs 只取 anchor、srcset、currentSrc、src，所以漏用了真实放大入口。
“1024px”只是先前模型描述，未得到原件支持。没有请求放大 URL，不能声称其实际像素就是
1800×2400，也不能断言采用大图即可解决视觉误读。

196/197 的这些原因核实已补入评论；两项仍待后续修复，不修改或重新提交原产品。
第三方站可选资料不完整可以继续，但实质成分误读不能算正确性验收通过。
