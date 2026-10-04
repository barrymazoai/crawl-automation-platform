# Facts 行内数量验证

关联CRAWLV3-205/184/151。用户继续下一步：修复Papaya180ct把原图明确印出的
“Includes 0 g Added Sugars”误判数量不可读。原失败label-b0a64ca6…及同图90ct成功
label-e0c4139c…保留；原图SHA52bdb8069e25635ac59fb48c2722fed48df63287b222886ba695d743fb2f8782。

根因是通用视觉提示仅规定“visible amounts → printed”，未明确同一行文字内的数量
无需独立金额/数量列。修改label-vision/8：明确行内数量、单位、零值也是printed，
引用原行证据；不把%DV、标识符、别行、营销或等效量当作该行剂量。真正缺失/模糊仍
保留原校验，不添加产品/关键词回填、不改采集。提示及完整模型指纹随版本更新。

没有新增或运行单元测试。只同步已有协议快照中的两个提示hash与policy版本，防止
旧版本快照与明确升级矛盾；验收使用必要静态/构建及Mini真实留存原件、原处理流程。
05:03Z开工前held=[]，DTC paused/queued686，其他五渠道无running/ready/queued。
