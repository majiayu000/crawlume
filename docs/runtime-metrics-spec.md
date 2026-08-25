# Diaoyan v0.9 运行统计规范

## 目标

用不依赖 LLM 的本地聚合指标回答三个运维问题：内容读取是否稳定、主要失败原因是什么、一次读取
消耗了多少可测量资源。统计服务不得进入抓取决策，也不得因为评分模型增加网络调用或 Token 成本。

## 适用范围

- 统计 `read_page`、CLI `read`、同步 Crawl 和异步 Crawl 产生的逐页内容读取。
- `inspect_page` 复用内容读取链路，因此同样计数。
- 纯站点 Map 和 Search 暂不进入本统计，避免把链接发现和正文读取混成一个成功率。
- 每次调用只记一个最终成功或失败；重试次数和等待时间作为该调用的成本证据累计。

## 数据与隐私

- 使用现有 SQLite 文件中的独立严格表，按 UTC 日期和有限维度聚合。
- 不保存 URL、hostname、标题、正文、查询词、代理地址、Cookie 或授权 Profile。
- 成功维度只包含 `fetchMethod` 和 `cached`；失败维度只包含稳定错误码。
- 缓存命中的上游字节、尝试和重试等待记为 0，正文字符仍计入交付量。

## 输出

`get_crawler_stats` MCP 工具和 `diaoyan stats --days <1-90>` CLI 返回同一结构：

- `generatedAt`、`since`、`days`。
- `totals`：请求、成功、失败、成功率、缓存命中及命中率。
- `fetchMethods`：实时成功读取中 HTTP 与 Browser 的数量，缓存命中不重复计入。
- `cost`：实时响应字节、交付正文字符、读取尝试、重试等待毫秒和总墙钟耗时。
- `failureReasons`：按数量降序的稳定错误码。
- `daily`：每日请求、成功、失败、缓存命中、响应字节和耗时。

无请求时两个比率返回 `null`，不得伪造 0% 或 100%。日期窗口包含今天并按 UTC 自然日计算。

## 错误语义

- `days` 不是 1-90 的安全整数时返回 `INVALID_ARGUMENT`。
- SQLite 写入或查询失败必须显式失败，不能静默丢失统计。
- 原始读取失败先标准化再统计；统计写入本身失败时不得谎称读取成功。

## 影响文件

- `src/metrics.ts`：聚合写入和窗口查询。
- `src/types.ts`：稳定统计输出类型。
- `src/reader.ts`、`src/app.ts`：内容读取埋点和生命周期。
- `src/mcp.ts`、`src/cli/main.ts`：Agent 与运维查询入口。
- `tests/metrics.test.ts` 及现有 Reader、MCP、CLI 测试。
- `README.md`、`docs/spec.md`、`docs/roadmap.md`。

## 当前边界

- 不估算代理、带宽、CPU、浏览器或第三方服务的货币费用。
- 不做 Prometheus 导出、单 URL 追踪、租户计量或账单。
- 不做内容质量 Judge、Embedding 或语义去重。
- 变化检测和定时监控属于 v0.9 的后续独立阶段。

## 验收

- 实时成功、缓存成功和结构化失败分别准确计数。
- 成功率、缓存命中率、失败原因、方法和成本合计正确。
- 日期窗口排除窗口外聚合。
- 持久化统计在应用重启后仍可查询。
- 统计输出和统计聚合表均不包含请求 URL 或正文。
- CLI、MCP、类型检查、构建和全部测试通过。
