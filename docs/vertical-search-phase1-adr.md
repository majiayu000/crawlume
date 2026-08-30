# AI 工具与开发者文档垂直搜索一期 ADR

状态：Approved for implementation

日期：2026-08-31

关联文档：[搜索引擎架构全景](./search-engine-architecture-landscape.md)、
[本地搜索规范](./local-search-spec.md)、
[一期完成账本](./vertical-search-phase1-ledger.md)

## 1. 决策

一期建设 AI 工具与开发者文档的自主垂直索引，采用分层准入：

1. 官方域名白名单是主来源。域名根 URL 直接准入，站内链接由现有 Durable Frontier 发现。
2. 人工 URL 是精确补充。只准入该 URL，不自动扩大到整个域名。
3. SearXNG 只负责冷启动发现。结果先进入候选池；白名单内 URL 自动准入，白名单外 URL 保持
   `pending`，必须显式批准或拒绝。
4. 核心查询只读取自有 SQLite FTS5。SearXNG 不参与自主索引的在线查询结果。

一期硬上限为 600 个官方域名、300,000 个当前可搜索页面和每日 60,000 次 Provider 尝试。
这些是容量边界，不要求冷启动时一次填满。

## 2. 复用边界

- 抓取继续使用 `DurableCrawlService`、SQLite Frontier、按 origin 礼貌间隔和累计 Crawl Budget。
- 原始响应继续使用现有 `raw_objects` 内容寻址存储；解析 Artifact 继续使用现有 `artifacts`。
- 当前可搜索投影继续使用 `indexed_pages` 与 SQLite FTS5。
- 搜索继续使用 `SearchService(source=local)`，不增加另一套查询服务。
- 垂直控制层只新增 seed、candidate、daily run、run job 和 query judgment 状态，不复制抓取事实或正文。

一期不增加分布式队列、向量数据库、embedding、reranker、GPU、远程 worker 或全网拓扑。

## 3. 最小数据模型

`vertical_search_seeds` 保存 URL、origin、`domain|url` scope、
`official|manual|searxng` provenance、`pending|admitted|rejected` 状态、发现查询和最近调度时间。
同一规范化 URL 只有一条记录；官方来源可以把已有候选提升为 domain scope 并直接准入。

`vertical_search_runs` 保存每日计划状态、计划尝试数、开始时索引页数、完成时间和显式错误。
`vertical_search_run_jobs` 把每个 seed 与现有 durable crawl job 关联，只投影 job 状态与启动错误。

`vertical_search_queries` 保存固定 query 和人工确认的一个或多个期望 URL。评测每次直接执行当前
FTS5，并输出逐 query 排名及 Hit@10、Recall@10、MRR@10。没有 query judgment 时拒绝产生成功报告。

Raw/Artifact 版本由现有内容寻址表拥有；FTS 当前投影按 final URL 更新。`indexed_page_versions` 只记录
内容 hash、抓取时间和 extractor/validator 版本，用于审计“何时因什么处理版本产生过哪个搜索投影”，
不重复保存原始正文。

### 3.1 初始官方来源与固定 query set

以下一期集合在 2026-08-31 由官方文档核验。origin 作为官方 domain seed；每行 query 与 gold URL
通过 `setQueryJudgment` 写入持久 judgment 后，才允许生成质量报告。页面迁移时必须人工更新 gold，
不能把 404 或重定向后的错误页面算相关结果。

| Query | Gold URL |
| --- | --- |
| OpenAI Responses API create response | `https://developers.openai.com/api/reference/cli/resources/responses/methods/create` |
| Anthropic Claude tool use | `https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview` |
| Gemini API function calling | `https://ai.google.dev/gemini-api/docs/function-calling` |
| Model Context Protocol architecture | `https://modelcontextprotocol.io/specification/2025-06-18/architecture` |
| Vercel AI SDK generateText | `https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text` |
| Hugging Face Transformers pipeline | `https://huggingface.co/docs/transformers/pipeline_tutorial` |
| LangChain Python tools | `https://docs.langchain.com/oss/python/langchain/tools` |
| LiteLLM proxy quick start | `https://docs.litellm.ai/` |
| vLLM OpenAI compatible server | `https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/` |

## 4. 每日增量合同

每日运行从已准入 seed 生成有界计划。精确 URL 每次最多占一个页面；剩余容量平均分给官方域名，
单域每天最多 100 页。计划总页数同时受以下三项约束：

- 当日剩余 Provider 尝试，最多 60,000。
- 当前索引距离 300,000 页的剩余容量。
- 已准入 seed 的实际数量。

每个 crawl page 的执行预算最多一次 Provider 尝试，因此所有已启动 job 的累计最大尝试数不会超过
当日计划。运行启动、job 终态与错误持久化；全部 job 成功为 `completed`，部分失败为 `partial`，
全部失败为 `failed`，仍有 job 执行为 `running`。没有已准入 seed、索引已满或重复启动同一 UTC 日
都会明确失败，不伪装成无工作成功。

## 5. 验收

- 三种来源都能进入统一候选/准入模型，并保留 provenance。
- SearXNG 故障不影响已有索引查询，且 discovery 故障显式抛出。
- 600/300,000/60,000 三个边界由聚焦测试验证，SQL 全部参数化。
- 每日运行只创建现有 durable crawl job，重启后可由持久 job ID 重新汇总状态。
- 内容变化产生版本审计记录，未变化重抓不产生重复版本。
- 固定 query set 能生成确定性的逐 query 结果和聚合指标。
- 类型检查、构建、聚焦测试、全量测试和 Patch Guard 审核全部通过后关闭账本。
