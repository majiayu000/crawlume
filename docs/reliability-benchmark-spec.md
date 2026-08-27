# Diaoyan Reliability Benchmark 规范

状态：Architecture Spec，尚未实现
最后更新：2026-08-28

## 目标

建立一套可重复、可解释、能驱动架构决策的网页读取真值系统。Benchmark 不回答“请求是否返回
200”，而回答“用户是否在给定时间与成本预算内拿到了正确、完整、足够新、可追溯的结果”。

产品优化的唯一总目标是降低单位有效结果成本：

```text
cost_per_valid_artifact = total_execution_cost / valid_artifacts
```

成功率、错误成功率、延迟、浏览器使用率和重试放大率是解释该指标的组成部分，不能分别优化到互相
伤害。例如，默认对所有页面启动浏览器可能提高原始成功率，却会恶化成本和吞吐；把登录页当正文
返回会提高调用成功率，却会降低真实可信度。

## 术语和真值标签

### Eligible request

只有满足以下条件的请求进入有效成功率分母：

- URL、输出目标和预算合法。
- 请求属于 Benchmark 声明支持的内容类型。
- 公开页面允许读取，或测试用授权会话由操作者明确提供。
- 不要求绕过 robots、登录、付费、验证码或访问控制。

策略拒绝、明确不支持和测试环境自身故障单独统计，不能混入产品失败，也不能伪装成成功。

### Outcome

| 标签 | 定义 | 是否计入有效成功 |
| --- | --- | --- |
| `valid` | 所有必需断言通过，结果满足任务目标 | 是 |
| `uncertain` | 可以返回，但至少一个必需维度无法确定 | 否，单独统计 |
| `invalid` | 返回 `ok`，但真值断言证明内容错误或残缺 | 否，计入错误成功 |
| `failed` | 系统明确返回稳定错误，没有伪装成功 | 否 |
| `policy_stop` | robots、许可、登录、付款或人工验证边界要求停止 | 不进入产品失败 |
| `unsupported` | 内容类型或能力不在声明范围内 | 不进入产品失败，但必须可见 |
| `harness_error` | Fixture、网络探针或 Benchmark 本身故障 | 本轮样本无效 |

### Validity dimensions

每个 Case 明确哪些维度是必需项：

- `identity`：最终 URL、标题、实体 ID 或 canonical URL 正确。
- `completeness`：必需段落、项目、页码或字段没有缺失。
- `fidelity`：正文和结构没有被导航、脚本、重复内容污染。
- `freshness`：结果满足 Case 声明的最大年龄。
- `schema`：结构化输出满足版本化 Schema 和字段约束。
- `provenance`：抓取方式、时间、Hash、Adapter 版本和访问上下文可追溯。

## 核心指标

| 指标 | 公式 | 用途 |
| --- | --- | --- |
| Valid Result Rate | `valid / eligible` | 用户真实拿到可用结果的概率 |
| False Success Rate | `invalid / returned_ok` | 最重要的可信度风险 |
| Uncertain Rate | `uncertain / eligible` | 验证器覆盖不足或页面不确定性 |
| Cost per Valid Artifact | `total_cost / valid` | 产品总优化目标 |
| Valid Latency p50/p95 | 有效结果端到端耗时分位数 | 体验与容量规划 |
| Browser Escalation Rate | `browser_started / eligible` | 昂贵路径使用率 |
| Browser Uplift | `http_invalid_then_browser_valid / browser_started` | 浏览器是否真正创造价值 |
| Retry Recovery Rate | `valid_after_retry / retried` | 重试收益 |
| Retry Waste Rate | `failed_after_retry / retried` | 重试浪费 |
| Crawl Coverage | `expected_unique_pages_found / expected_unique_pages` | 站点发现完整性 |
| Duplicate Rate | `duplicate_artifacts / produced_artifacts` | Frontier 和规范化质量 |
| Recovery Loss | 恢复后丢失或重复执行的 Request 数 | 耐久任务正确性 |

`raw success rate` 只作为操作指标保留，不得成为发布门槛或营销数字。

## 成本模型

P0 不估算虚构货币成本，先采集可观测资源代理：

```text
ExecutionCost {
  httpRequests
  networkBytesIn
  networkBytesOut
  browserMilliseconds
  browserContextStarts
  proxyBytes
  cpuMilliseconds
  peakMemoryMb
  storageBytesWritten
  retryAttempts
  retryDelayMilliseconds
  optionalModelTokens
}
```

当部署环境提供真实单价后，由独立 `CostModel` 将这些资源代理换算为金额。Benchmark 原始记录永远
保留资源量，避免价格变化后历史结果失真。

## Corpus 设计

Benchmark 使用三层 Corpus，三者不得互相替代。

### Layer A：Hermetic fixtures

仓库内固定输入，覆盖：

- 静态文章、文档、列表、分页和重复导航。
- JSON、JSON-LD、RSS、Sitemap、纯文本和 PDF。
- JavaScript Shell、延迟正文、Skeleton 和无限滚动的受控变体。
- 登录墙、付款墙、人工验证页和错误页。
- 重定向、canonical、超大响应、断流、乱码和错误 Content-Type。
- 429、`Retry-After`、临时 5xx、超时和浏览器崩溃。

Layer A 用于每次提交的确定性回归，不依赖公网。

### Layer B：Controlled sites

本地测试服务或专用测试域动态模拟网络、DOM 和运行时行为：

- 可配置响应延迟和分块传输。
- 在指定时间插入正文或目标元素。
- 返回可重复的限速和故障序列。
- 模拟进程中断、任务恢复和结果去重。
- 输出服务器端请求计数，用于核对重试和缓存行为。

Layer B 验证调度、等待、恢复和成本，不承担真实网站代表性。

### Layer C：Live canaries

选择公开、稳定、用途明确的真实 URL。真值使用不易漂移的结构断言，而非全文快照：

- 页面标题或 canonical 域名。
- 必需 heading、代码块、表格或正文长度区间。
- Sitemap/Feed 至少包含的已知入口。
- PDF 页数或固定章节。
- 明确的 gate page 必须被拒绝。

Live Case 必须记录最后审核时间和最大有效期；过期 Case 自动进入 `harness_error`，不得将网站改版
算成产品回归。

## Case Manifest

建议规范源为 `benchmarks/cases/*.json`，Schema 为 `benchmarks/schema/case.schema.json`：

```json
{
  "id": "article-static-001",
  "layer": "fixture",
  "category": "article",
  "input": {
    "url": "http://controlled.test/article/001",
    "intent": "read",
    "freshnessSeconds": 0
  },
  "policy": {
    "browserAllowed": true,
    "authProfile": null,
    "maxAttempts": 2,
    "maxDurationMs": 10000,
    "maxBrowserMs": 3000
  },
  "truth": {
    "required": [
      { "type": "title_equals", "value": "Example Article" },
      { "type": "contains_text", "value": "ground truth paragraph" },
      { "type": "min_content_characters", "value": 1200 }
    ],
    "forbidden": [
      { "type": "contains_text", "value": "Sign in to continue" }
    ]
  },
  "reviewedAt": "2026-08-28T00:00:00Z",
  "expiresAt": null
}
```

Manifest 只描述输入、预算和真值，不指定必须使用 HTTP 或 Browser。否则 Benchmark 会测实现细节，
无法评估 Access Planner。

## Harness 边界

```text
Case Loader
  -> Isolated Run Coordinator
     -> Diaoyan public contract
        -> Result Collector
           -> Truth Evaluator
              -> Metrics Aggregator
                 -> JSONL + summary.json + human report
```

- Harness 只能通过公开 Reader/Crawl 合同调用系统，不得 import 私有函数制造虚假通过。
- Truth Evaluator 是独立消费者，不得使用生产 `validateContent` 作为唯一真值。
- 每个 Case 在独立数据目录运行，或显式声明共享缓存实验。
- 运行记录包含 Git SHA、Node/Chrome 版本、配置 Hash、Case Set Hash 和开始时间。
- 原始结果保存为有界 JSONL；HTML、Trace 和截图只在失败或抽样时保存。
- 授权页面、Cookie、Token 和正文敏感内容不得进入公共 Benchmark 工件。

## Benchmark 运行模式

| 模式 | 目的 | 默认网络 |
| --- | --- | --- |
| `pr` | 快速阻止确定性回归 | Layer A/B |
| `nightly` | 完整资源与恢复测试 | Layer A/B，少量 C |
| `release` | 发布候选对照 | 全部有效 Case |
| `competitor` | 同 URL、同预算外部对照 | Layer C，显式 API Key |
| `shadow` | 线上小样本比较规划路径 | 真实流量，严格采样和隐私边界 |

外部竞品对照必须记录套餐、地区、选项和时间；不能把一次测试外推成永久排名。

## 防止 Benchmark 被优化作弊

- Case ID 和 URL 不得被生产 Planner 特判。
- Release 评测包含未公开的保留 Case。
- 断言以用户目标为中心，不以特定 HTML 选择器为中心。
- 单项提升若造成 False Success 或 Cost per Valid Artifact 恶化，不能宣称整体提升。
- Case 删除、降级或放宽断言必须单独 review，并在报告中保留前后影响。
- 测试失败必须修生产实现或真值错误，禁止只改期望值让结果变绿。

## 发布门槛

建立首个 baseline 后再填写具体数值。没有 baseline 前不承诺虚构 SLO。

每个 Release 至少满足：

- P0 Corpus 的 Valid Result Rate 不低于当前发布基线。
- False Success Rate 不得回归。
- Cost per Valid Artifact 的变化可解释。
- 每个新增 Provider/Adapter 至少有合同测试和一个失败 Case。
- 浏览器路径必须报告 Uplift，不能仅报告浏览器成功数。
- 恢复测试证明没有静默丢页和不可解释重复。

## 建议实现位置

| 边界 | 建议路径 | 禁止依赖 | 测试/验证 |
| --- | --- | --- | --- |
| Case Schema | `benchmarks/schema/` | 生产数据库 | Schema fixture validation |
| Case Loader | `benchmarks/harness/cases.ts` | Provider 私有实现 | malformed/expired Case tests |
| Truth Evaluator | `benchmarks/harness/evaluate.ts` | `src/validation.ts` 作为真值 | assertion matrix tests |
| Run Coordinator | `benchmarks/harness/run.ts` | 直接调用私有 extractor | controlled-site integration |
| Cost Aggregator | `benchmarks/harness/cost.ts` | 硬编码商业价格 | deterministic aggregation tests |
| Controlled Site | `benchmarks/controlled-site/` | 外部网络 | fault-sequence E2E |
| Reports | `benchmarks/reports/`，默认 gitignored | 凭证、Cookie、敏感正文 | redaction tests |

## P0/P1/P2

| 优先级 | 工作 | 完成条件 | 验证 |
| --- | --- | --- | --- |
| P0 | Case Schema、Layer A、Truth Evaluator、JSONL 报告 | 文章、Shell、gate、JSON、429、超时 Case 可确定运行 | `pnpm test -- tests/reliability-benchmark.test.ts` |
| P0 | Controlled Site 和成本采集 | 能证明请求次数、等待、浏览器时间和恢复结果 | `pnpm test -- tests/reliability-controlled-site.test.ts` |
| P1 | Layer C Canary 与 Case 过期机制 | 网站漂移不会伪装产品回归 | `pnpm bench --mode nightly` |
| P1 | Release 对照和趋势报告 | 同 Case Set 可比较两个 Git SHA | `pnpm bench --mode release --compare <baseline>` |
| P2 | 竞品与 Shadow 模式 | 外部配置可复现，敏感信息不入工件 | `pnpm bench --mode competitor`; redaction tests |

## 非目标

- 不证明“任何网站都能抓”。
- 不以绕过访问控制、验证码、付费墙或 robots 作为成功。
- 不在 P0 用 LLM 充当全部真值。
- 不把压测吞吐等同于内容正确性。
- 不为 Benchmark 新建一套与生产无关的抓取实现。

## 开放问题

- 首批付费场景优先文章/文档，还是结构化列表/监控？这决定 Corpus 权重。
- PDF 与授权页面是否进入首个 P0，或作为 P1 独立能力包？
- Live Canary 的人工复核周期由谁负责？
- 外部竞品对照的预算上限和运行频率是多少？

## Readiness

本规范已经足够拆分 P0 Benchmark 工作，但 Benchmark 尚未实现，仓库也还没有有效成功率 baseline。
在首次可重复运行和人工核验完成前，不能声称 Diaoyan 已达到生产级可靠性或优于任何竞品。
