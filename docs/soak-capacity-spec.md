# 稳定性试验与容量基准规范

对应 [`hybrid-platform-architecture-plan.md`](./hybrid-platform-architecture-plan.md) §39 的
「7-day Soak Specification」和「300k Capacity Benchmark Specification」。

## 运行方式

`pnpm bench:soak` 启动已构建的 MCP 进程，对受控站点反复提交 durable crawl job（`maxDepth: 1`，
每个 job 最多 10,000 页），按固定间隔采样 MCP 进程 RSS。

| 参数 | 默认 | 说明 |
|---|---|---|
| `--duration-minutes` | 10 | 运行时长上限，最多 20,160（14 天） |
| `--total-pages` | 0 | 达到页数即停止；0 表示跑满时长 |
| `--pages-per-job` | 1000 | 每个 job 的页数，1–10,000 |
| `--concurrency` | 16 | job 并发与全局 Worker 并发 |
| `--sample-seconds` | 30 | RSS 采样间隔 |
| `--max-rss-growth-percent` | 50 | 内存增长门槛 |
| `--report-dir` | `benchmarks/reports/soak-<时间>` | 输出 `samples.jsonl` 与 `summary.json` |

```bash
pnpm build
# 7 天稳定性试验
pnpm bench:soak --duration-minutes 10080 --pages-per-job 10000
# 300,000 页容量基准
pnpm bench:soak --duration-minutes 1440 --total-pages 300000 --pages-per-job 10000
```

GitHub Actions 的 `Soak` workflow 可手动触发最长 6 小时的运行并上传报告；7 天试验需要自有长期运行主机。

## 通过条件

全部满足才返回退出码 0：

1. 每个 job 都以 `completed` 结束，且成功页数等于该 job 页数。
2. 采样不少于 8 个时，后 1/4 采样的 RSS 中位数相对前 1/4 的增长不超过门槛。
3. 设置 `--total-pages` 时，在时长上限内完成全部页数。
4. 采样或调用本身失败按失败处理，不跳过。
5. `--total-pages > 0` 开启本地索引，每个 job 使用独立 URL 批次；读回 distinct final URL、历史 URL 和
   FTS `durable` 命中数，必须都等于目标页数。300,000 页时另验证已有 URL 仍可更新，新 URL 返回
   `BUDGET_EXHAUSTED`。超过索引容量的目标会失败。

时长限制贯穿 start、poll 和容量验证，超时结果不计为成功；吞吐计时在 teardown 之前结束。
每次运行重置 `samples.jsonl`；受控站点每批清空请求历史，RSS 峰值迭代计算，内存只保留 RSS 数值序列。

## 边界

- 受控站点在本机，结果衡量的是 Crawlume 自身的调度、存储和内存行为，不代表公网站点的成功率或速度。
- 每个 job 使用 `cacheMode: live`，不依赖缓存命中。
- 只采样 RSS；SQLite 文件增长和磁盘占用从 `CRAWLUME_DATA_DIR` 另行观察。
