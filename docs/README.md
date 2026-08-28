# Diaoyan 文档索引

## 当前实现合同

- [spec.md](./spec.md)：已经实现并应保持兼容的完整产品合同。
- [roadmap.md](./roadmap.md)：按依赖排序的后续实现路线。
- [product-strategy.md](./product-strategy.md)：产品价值、付费理由和交付边界。
- [competitive-landscape.md](./competitive-landscape.md)：竞品桌面调研及尚未完成的真实对照。

## 技术选型与目标架构

以下两份文档是进入下一轮实现前的决策入口：

1. [crawler-architecture-landscape.md](./crawler-architecture-landscape.md)
   基于官方文档、源码、标准和论文，对开源框架、分布式爬虫、归档系统、浏览器基础设施和闭源
   抓取/检索 API 做架构节点对比，并明确证据等级与尚不可知的内部实现。
2. [technology-selection-rfc.md](./technology-selection-rfc.md)
   比较四套候选架构，给出语言、Frontier、存储、队列、Browser、提取和验证的推荐选型、架构图、
   量化门槛、风险及实施顺序。

在 RFC 获得产品事实和 Phase 0 Benchmark 校准前，它是 Proposed 决策，不是已实现状态。若目标选型与
较早的可靠性文档出现冲突，以 RFC 作为待批准的决策建议；只有代码与测试落地后才能更新
`spec.md` 的实现合同。

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
目标可靠性架构      docs/reliability-architecture.md
真值与评测合同      docs/reliability-benchmark-spec.md
研究过程与假设      docs/reliability-exploration-log.md
实施顺序            docs/roadmap.md
```

目标架构文档不能被当作“已经实现”的证据。每个阶段完成后，应先更新代码和测试，再同步
`spec.md` 与 Roadmap 的完成状态。

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
