# 网页代码正文修复与 Codex MCP 接入

本轮聚焦读取给定 URL、站内链接发现和抓取。搜索索引继续默认关闭；本机 Codex 配置禁用了 `search_web`、`get_search_status` 和 `get_search_stats`。外部搜索负责找到 URL，Crawlume 负责取得正文和来源。

## 正文修复

- Readability 会依据容器样式名称过滤内容。MCP 文档代码外层的滚动和 hidden 样式词曾导致代码被删除；现在先把仅包含代码的展示容器转换为语义化 `pre/code`，不修改正文顺序，不提升隐藏节点。
- HTML 高亮器可能用 `br` 或逐行 `div` 表示换行。转换前恢复代码行分隔，保留空行和行尾空格，避免行注释吞掉后续代码。
- 没有嵌套 `code` 的 `pre` 也产生围栏代码块；已有语言声明会保留。
- 高亮器的类型信息和编译器诊断保留在代码块外，重复覆盖层不混入源码。代码块旁的语言标签、复制或 Try 控件不混入代码。
- 提取行为版本更新为 `readability-v2`、`document-v2`。这是正文结构处理，没有新增站点白名单、站点 Adapter 或搜索系统。

## 固定输入验收

复用上一轮五站 20 页保存的原始 HTML，避免网站变化影响对照。检查不是只比较 Markdown 字符串，而是用 Markdown 解析器读取实际代码块，正确处理嵌套列表缩进，再与 HTML 中可见的源码行比较。高亮器的诊断信息与重复悬浮层不计入源码。

| 文档站 | 可见源码块 | 内容与换行匹配 |
| --- | ---: | ---: |
| MCP | 42 | 42 |
| Playwright | 95 | 95 |
| TypeScript | 87 | 87 |
| HTTPX | 78 | 78 |
| Vite | 95 | 95 |
| 合计 | 397 | 397 |

Playwright 中未激活的隐藏语言面板没有被提升为正文。MCP 的 Tools、Resources、Prompts 原来分别丢失 15、17、10 个代码块，本轮全部恢复。

这证明本批固定网页的代码保留情况，不代表任意站点或未执行的浏览器交互都已获得完整性证明。

本地证据位于 `benchmarks/reports/code-content-20260909/`：

- `replay.json` 与逐页 Markdown：固定 HTML 回放结果。
- `mcp-live.json` 与 `live-*.md`：读取本机已安装 MCP 配置，从 `/tmp` 工作目录启动服务，对 MCP Tools、Playwright Locators、HTTPX Timeouts 进行实时读取。
- 实时检查确认使用 `readability-v2`，MCP Tools 的 JSON 请求示例、Playwright 的代码换行和 HTTPX 的围栏代码均存在；本地索引未开启，未配置 Web 搜索 Provider。

验证命令 `pnpm check`、`pnpm build`、`pnpm test` 均通过；全量为 60 个测试文件、525 个测试。

这些网页正文工件保持 gitignored；克隆仓库不会自动带上本机历史语料。

## 日常使用

本机已经添加 `~/.codex/config.toml` 中的 `mcp_servers.crawlume`，使用绝对 Node 和构建入口路径，不依赖当前工作目录。数据继续使用 `~/Library/Application Support/crawlume/`，没有改动 `.env`、凭证或已有授权 Profile。

可以直接向已加载该 MCP 的 Codex 会话提出：

- “用 Crawlume 读取这个 URL，保留代码和来源。”
- “列出这个文档站的链接，最多 20 页。”
- “抓取这些站内页面，报告失败页面。”

当前会话若未显示新工具，重新打开会话后检查。可用 `codex mcp get crawlume` 查看本机配置。配置使用本机 Fake-IP 开关；其他普通 DNS 环境不需要这个选项。

仓库代码更新后运行 `pnpm build`，再重新启动使用旧构建的 MCP 进程。普通 CLI 仍可使用 `pnpm cli read <url> --markdown`。

搜索实现保留为可选能力，没有启用语料采集定时任务，也没有新增向量库或管理后台。
