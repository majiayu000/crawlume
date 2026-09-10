# 开发者文档采集与检索试用

这份试用固定 MCP、Playwright、TypeScript、HTTPX、Vite 五站，每站四个问题。问题由 Agent 根据常见开发任务编写，不冒充真实用户访谈或历史查询。目标 URL 与英文检索词在第一次采集前冻结于 `benchmarks/docs-trial/cases.json`。

首轮采用 20 个精确人工 URL，通过已有 `VerticalSearchService` 与 durable crawl 抓取、保存来源并建立本地 FTS5 索引。它检验受控语料的采集和检索，不代表全站覆盖或开放 Web 搜索质量。MCP 使用固定的 2025-06-18 协议版本。

站点发现试用改用五个官方域名首页作为 seed，由 Durable Frontier 在深度 3、每域最多 100 页内发现页面；图片和压缩包等静态资源不入队。目标页必须被发现才会进入索引；同站无关页面作为检索干扰。题集仍是那 20 个问题，fixture 为 `benchmarks/docs-trial/discovery.json`。MCP 发现金标使用首页当前链接到的规范版本；精确 URL 试用仍冻结 2025-06-18。

## 运行

在仓库根目录执行。试用数据库与授权 Profile、默认运行数据隔离；不要把其他 seed 或 query judgment 混入这个目录。

```bash
pnpm build
export CRAWLUME_DATA_DIR="$HOME/Library/Application Support/crawlume/docs-trial-20260909-final"
export CRAWLUME_LOCAL_INDEX_ENABLED=1
# 仅在本机 Clash/TUN DNS 返回 Fake-IP 时设置。
export CRAWLUME_ALLOW_DNS_FAKE_IP=1
pnpm trial:docs collect benchmarks/reports/docs-trial-20260909-final
```

站点发现试用必须使用新的数据目录和报告目录，并把 fixture 作为第四个参数：

```bash
export CRAWLUME_DATA_DIR="$HOME/Library/Application Support/crawlume/docs-trial-discovery"
export CRAWLUME_LOCAL_INDEX_ENABLED=1
export CRAWLUME_ALLOW_DNS_FAKE_IP=1
pnpm trial:docs collect benchmarks/reports/docs-trial-discovery benchmarks/docs-trial/discovery.json
pnpm trial:docs evaluate benchmarks/reports/docs-trial-discovery benchmarks/docs-trial/discovery.json
```

脚本保留 run ID，重复上述命令会恢复相同任务及结果，不创建另一轮抓取。进程中断后也可用同一命令继续。每个精确 URL 沿用一期 daily run 的一次 Provider 尝试预算，因此需要第二次获取路径或重试的页面可能明确失败。

复评已保存语料，不启动抓取或监控 Worker，查询严格使用 `source=local`：

```bash
pnpm trial:docs evaluate benchmarks/reports/docs-trial-20260909-final
CRAWLUME_LOCAL_INDEX_ENABLED=1 pnpm cli search 'HTTPX AsyncClient async' --source local
```

上述命令继续使用前面导出的 `CRAWLUME_DATA_DIR`。新的一轮采集使用新的报告目录；同一数据目录每天只能启动一次 daily run。修改题集后请使用新的独立数据目录和报告目录，避免旧语料与判断污染结果。

## 阅读结果

- `report.md`：20 个问题的目标页面、采集状态以及两组 Top 10 排名。
- `report.json`：查询结果与执行来源、逐页验证结果、哈希、时间、获取路径、任务预算和错误。
- `pages/*.md`：本次抓取的正文，可与官方网页逐项对照。
- `collection.json`：指向 SQLite 中的 durable run，供进程恢复使用。

采集失败会写进报告并以退出码 2 结束。检索未命中属于评测结果，不会被替换成网络搜索答案。异常或缺少采集状态会明确报错。

中文问题原文和预先编写的英文检索词分开计分。后者只验证 Agent 可以通过英文词使用索引，不是已实现的自动翻译或查询改写。每题只标注一个目标页，Hit@10 与 Recall@10 因而相同；其他相关页面不构成穷举判断。

`valid` 是产品自身验证结果，不能充当独立正文质量证明。人工核对需要记录页面中的回答依据、代码示例是否保留，以及遗漏或导航污染。采集失败、正文问题和排序未命中应分开解释。

## 在 MCP 客户端使用这个语料库

构建后将以下条目加入客户端配置，将两个绝对路径替换为本机实际路径。服务会打开已有试用数据库；这不会自动执行下一轮 daily run。

```toml
[mcp_servers.crawlume-docs]
command = "node"
args = ["/absolute/path/to/crawlume/dist/server.js"]
[mcp_servers.crawlume-docs.env]
CRAWLUME_DATA_DIR = "/absolute/path/to/crawlume/docs-trial-20260909-final"
CRAWLUME_LOCAL_INDEX_ENABLED = "1"
# 本机 Clash/TUN Fake-IP 环境需要；普通 DNS 环境省略。
CRAWLUME_ALLOW_DNS_FAKE_IP = "1"
```

调用 `search_web` 时明确传 `source: "local"`，使用题集中的 `agentQuery` 可复现英文词检索。返回的 URL 可供引用；`read_page` 默认缓存有时效，若需要严格复现本次正文，应查看报告目录中的 Markdown。

本次实跑的结论与未解决问题见 [docs-trial-results.md](./docs-trial-results.md)。
