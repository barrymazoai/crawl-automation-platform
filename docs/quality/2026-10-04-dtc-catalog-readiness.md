# DTC 目录就绪检查与原文节点

CRAWLV3-203，关联200/183/151。HMW回归f8cc235d-097e-4cbc-b1e3-d81c2c0a8b53
在7cfadc8于03:33:30Z Review；唯一固定入口调用在prepare.waitForFunction超时，未枚举。

最初根据截断输出怀疑网格ID写错，完整gridInfo证实两个ID都存在，这个判断已撤回。
已保存的bodyText没有“6 products”，snapshot却有；此前完整扫描8065832a的原始HTML
确认数量在过滤抽屉`.mobile-facets__count`，body.innerText不包含这个隐藏节点。
脚本把整个body文字出现数量作为就绪条件，页面和商品均已就绪仍等到超时。
同一候选另将找到的原文“HMW Method”与“HMW METHOD”直接比较，会继续产生误报。

复用真实观察的网格、数量和卡片标题/品牌节点，保存修复候选hmw.mjs；不新增通用匹配器，
不硬编码商品、数量或业务字段。读取原文品牌，保留同目录总数比较。仅在本次卡片数等于
该目录总数、实际确认无分页后走单页旧枚举；结构变化仍由Codex采前局部处理。
给新建/改动的方法明确就绪条件核验，不把普通CSS大小写/隐藏状态当成业务失败。

17原件/1,357,150字节于03:36:00Z全量R2回读通过；03:36:21Z停止审计1许可/4执行
invalid=[]。历史失败不改写。静态检查、Mini真实原件与新站点验证待回填；不新增单元测试。

a6e98515b76fa603628b53dc42c2abe05fcdab71已main push，pnpm check及MJS语法检查通过。
03:43:22Z Git部署Server二browser-worker完成。03:43:45Z直接以原完整8065832a
目录HTML验证：候选投影的6个URL集合与保存的发现集合相同，标题/品牌完整，数量节点
原文6 products与卡片数相同。HTML SHA为4f171d22a2d603201e808a9cc1809d4b46171919999cbcddee3b2dd297dee734，
回执Server二manual-releases/catalog203-retained/proof.json。新实站任务
e9e5cf87-c2ac-44bf-8f18-4b8a57c23415于03:43:53Z单项入队，终态待核对。

实站03:43:55Z开始，03:48:21Z宿主complete/full=true：6个唯一产品，单页两轮、
第二轮growth0，expected/observed=6/6；recent6、added0/newListings0/queued0。
实际查看preflight-grid-end截图，包含最后两张商品卡片和网格末端，不是网站页脚替代。
修复候选未经模型改写，公共脚本与实际源字节一致，保存为verified：
4046bc1983e6fa0b05d572d8d6b9897c79e66722a5b9c42a957716e12e0f9a3c。
31原件/5,539,919字节03:48:52Z全量R2回读通过；03:49:00Z停止审计1许可/4执行
invalid=[]。203交Review。没有重跑旧HMW商品或把历史Review改为成功。
