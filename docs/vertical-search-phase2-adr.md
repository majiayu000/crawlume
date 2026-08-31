# AI 工具与开发者文档垂直搜索二期数据层 ADR

状态：Implemented

日期：2026-08-31

关联文档：[一期 ADR](./vertical-search-phase1-adr.md)、
[二期完成账本](./vertical-search-phase2-ledger.md)、
[本地搜索规范](./local-search-spec.md)

## 1. 目标

二期只补齐长期网页数据层的最小闭环：每次公开页面发布都把 Artifact、Raw 对象、请求 URL、
重定向链、最终 URL 和页面声明 canonical 组成一条可审计观察；按 URL 查询内容版本历史；在当前
FTS 投影丢失或 indexer 升级后，离线从既有 Raw/Artifact 重建；根据观察到的内容变化和距上次抓取
时间生成确定性的重抓优先级，并让现有垂直搜索调度使用该优先级。

## 2. 复用与边界

- `raw_objects` 与 `artifacts` 继续拥有不可变正文和解析结果，不复制正文。
- `indexed_pages` 与 FTS5 继续是唯一当前搜索投影。
- 新增的历史表只保存 Artifact/Raw 引用、URL 身份、处理版本和抓取观察；不增加新数据库。
- 每日重抓仍只创建现有 `DurableCrawlService` job，不增加第二套 frontier 或队列。
- 不建设 WARC、近似重复检测、分布式存储、向量索引、迁移兼容层或旧数据回填。

## 3. URL 身份与历史合同

一次可发布观察包含 requested URL、按顺序记录的 HTTP/Browser redirect edge、final URL 和可选的
declared canonical URL。canonical 只作为页面声明事实保存，不自动合并 URL，也不跨越现有准入和
安全边界。历史以 request ID 幂等写入，因此未变化重抓仍保留观察；内容版本按 Artifact 聚合，提供
首次/末次观察时间和观察次数。

授权 Profile、RSL approval 或 License Token 内容仍不得进入共享历史或本地索引。

## 4. 离线重建合同

重建只接受同时存在历史观察、对应 `artifacts` 行和对应 `raw_objects` 行的公开版本。每个 final URL
确定性选择最新观察（时间相同按 Artifact key 排序），清空并重建当前 FTS 投影。缺失 Raw 或 Artifact
属于数据完整性错误，整次重建回滚并显式失败。报告记录固定 indexer 版本和实际 parser/extractor
版本集合，不在线重新抓取。

## 5. 重抓优先级

从相邻观察的 content hash 变化次数计算 change rate，再加入有界的整日 stale age。未观察 URL 优先；
其余 URL 先按变化率、再按陈旧时间、最后按规范化 URL 排序。这个分数只影响已准入 exact URL 在
每日计划中的顺序，不改变容量、预算、domain 准入或 durable crawl 合同。

## 6. 验收

- URL 身份链由真实读取路径写入并可查询。
- 未变化观察保留，内容版本历史按 Artifact 确定性聚合。
- Cache 清理不会删除历史引用的 Artifact/Raw。
- FTS 可从已有 Raw/Artifact 离线重建；缺失依赖显式失败并回滚。
- 重抓优先级确定且进入现有 durable daily run 排序。
- 聚焦测试、类型检查、构建与 Patch Guard 全部通过。
