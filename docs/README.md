# Crawlume 文档索引

## 当前实现合同

- [code-content-verification.md](./code-content-verification.md)：代码正文保留与本机 Codex MCP 接入验收。

- [docs-trial.md](./docs-trial.md)：五个开发者文档站、20 个问题的真实采集与本地检索试用。

- [spec.md](./spec.md)：已经实现并应保持兼容的完整产品合同。
- [operations.md](./operations.md)：部署、配置、可观测性、备份恢复与升级手册。
- [soak-capacity-spec.md](./soak-capacity-spec.md)：7 天稳定性试验与 300,000 页容量基准的运行方式和通过条件。
- [roadmap.md](./roadmap.md)：已完成阶段、条件式能力与后续决策门。
- [architecture-completion-ledger.md](./architecture-completion-ledger.md)：本地模块化 Retrieval Runtime
  的逐目标实现和验证记录。
- [product-strategy.md](./product-strategy.md)：产品价值、付费理由和交付边界。
- [competitive-landscape.md](./competitive-landscape.md)：竞品桌面调研及尚未完成的真实对照。

## 技术选型与架构边界

方案 C 的 C/B 端混合交付目标、云端控制面、公共/私有 Worker、租户隔离、API、数据、部署和分阶段
实施计划见 [hybrid-platform-architecture-plan.md](./hybrid-platform-architecture-plan.md)。该文档是
目标架构，不改变 `spec.md` 所记录的当前本地实现合同。

以下三份文档分别覆盖独立目标，不能互相冒充实现状态：

1. [search-engine-architecture-landscape.md](./search-engine-architecture-landscape.md)
   对比 Brave Search、Firecrawl、Exa 与 Firefox 的真实系统边界、数据来源、索引与排序架构，说明
   Crawlume 从网页获取层走向自主搜索引擎目标 C 所缺少的数据面和分阶段建设路径；该目标
   不属于当前已完成的本地 Retrieval Runtime。
   已批准的一期实现边界见 [vertical-search-phase1-adr.md](./vertical-search-phase1-adr.md)，逐项进度见
   [vertical-search-phase1-ledger.md](./vertical-search-phase1-ledger.md)。长期网页数据层边界见
   [vertical-search-phase2-adr.md](./vertical-search-phase2-adr.md)，逐项进度见
   [vertical-search-phase2-ledger.md](./vertical-search-phase2-ledger.md)。检索实验与发布门槛见
   [vertical-search-phase3-adr.md](./vertical-search-phase3-adr.md) 和
   [vertical-search-phase3-ledger.md](./vertical-search-phase3-ledger.md)；公共查询执行证据见
   [vertical-search-phase4-adr.md](./vertical-search-phase4-adr.md) 和
   [vertical-search-phase4-ledger.md](./vertical-search-phase4-ledger.md)。本地生产就绪的三个独立闭环见
   [Phase 5 发布 ADR](./vertical-search-phase5-release-adr.md)、
   [发布账本](./vertical-search-phase5-release-ledger.md)、
   [备份 ADR](./vertical-search-phase5-backup-adr.md)、
   [备份账本](./vertical-search-phase5-backup-ledger.md)、
   [查询 SLO ADR](./vertical-search-phase5-slo-adr.md) 和
   [查询 SLO 账本](./vertical-search-phase5-slo-ledger.md)。
2. [crawler-architecture-landscape.md](./crawler-architecture-landscape.md)
   基于官方文档、源码、标准和论文，对开源框架、分布式爬虫、归档系统、浏览器基础设施和闭源
   抓取/检索 API 做架构节点对比，并明确证据等级与尚不可知的内部实现。
3. [technology-selection-rfc.md](./technology-selection-rfc.md)
   比较四套候选架构，给出语言、Frontier、存储、队列、Browser、提取和验证的推荐选型、架构图、
   量化门槛、风险及实施顺序；其中本地单机 Profile 已批准并实现，集群/托管扩展仍由门槛触发。

实现事实以 `spec.md`、代码、测试和完成账本为准。RFC 中未触发的本地 Retrieval Runtime 数据面
PostgreSQL 化、多主机 Worker、远程 Browser、托管 Provider 和新语言执行器仍只是条件式扩展；
方案 C 控制面 PostgreSQL 不属于这里的条件式扩展。目标 C 搜索引擎也需要独立批准。

## Reliability 核心计划

以下文档共同回答“如何让用户用更少成本获得更多可信结果”：

1. [reliability-benchmark-spec.md](./reliability-benchmark-spec.md)
   定义 eligible request、真值标签、指标、Corpus、Harness、成本模型和发布门槛。
2. [reliability-architecture.md](./reliability-architecture.md)
   定义状态所有权、Access Planner、Stage Executor、Attempt Ledger、Browser Readiness、
   Extractor/Validator Registry、Durable Frontier 和 ResourceGovernor。
3. [reliability-exploration-log.md](./reliability-exploration-log.md)
   记录本次研究形成的决策、假设、否证条件、实验和证据。

规范优先级：

```text
已实现行为          docs/spec.md + code/tests
本地可靠性架构      docs/reliability-architecture.md
真值与评测合同      docs/reliability-benchmark-spec.md
研究过程与假设      docs/reliability-exploration-log.md
实施顺序            docs/roadmap.md
```

架构文档不能单独充当实现证据；每个阶段都必须由代码、测试和账本验证后再同步 `spec.md` 与 Roadmap。

## 已实现的专项规范

- [crawl-policy-spec.md](./crawl-policy-spec.md)
- [async-crawl-spec.md](./async-crawl-spec.md)
- [browser-pool-spec.md](./browser-pool-spec.md)
- [proxy-pool-spec.md](./proxy-pool-spec.md)
- [runtime-metrics-spec.md](./runtime-metrics-spec.md)
- [change-monitor-spec.md](./change-monitor-spec.md)
- [local-search-spec.md](./local-search-spec.md)
- [search.md](./search.md)
- [agent-identity-spec.md](./agent-identity-spec.md)
- [rsl-policy-spec.md](./rsl-policy-spec.md)
- [rsl-olp-cap-spec.md](./rsl-olp-cap-spec.md)
- [rsl-approval-audit-spec.md](./rsl-approval-audit-spec.md)
- [rsl-payment-boundary-spec.md](./rsl-payment-boundary-spec.md)

## 外部镜像规则

如果未来把文档同步到 Notion：

- 默认把 Notion 视为阅读镜像，版本库是规范源。
- 必须指定 Notion 页面、同步方向、owner 和冲突处理方式。
- 不同步 Cookie、Token、授权正文、私有 Benchmark 工件或失败 Trace。
- 外部镜像更新不能先于仓库文档 review。

## 接管与讨论记录

- [2026-08-28 Apple 接管说明](./handoffs/2026-08-28-apple-handoff.md)
- [2026-08-28 Apple 迁移验证报告](./handoffs/2026-08-28-apple-transfer-report.md)
- [2026-08-28 Reliability 产品讨论记录](./handoffs/2026-08-28-reliability-product-conversation.md)

## 实现核对

- [2026-09-02 Codex 实现对照问题清单](./audits/2026-09-02-implementation-bugs.md)：对照 `spec.md` 与源码的实现错误，不含架构评价。
