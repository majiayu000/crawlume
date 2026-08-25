# Diaoyan v0.4 本地全文索引规范

## 目标

在管理员显式设置 `DIAOYAN_LOCAL_INDEX_ENABLED=1` 时，把已经由 Diaoyan 合规读取的公开页面
沉淀为本地可搜索语料，减少重复依赖外部搜索服务。该功能默认关闭，不属于爬虫核心执行链路。
本阶段不建设全网索引，不引入分布式队列，也不索引使用授权 Profile 读取的内容。

## 数据流

1. `read_page` 或 `crawl_site` 成功取得完整页面。
2. 未使用 `authProfile` 的页面按最终 URL 写入 SQLite，并用 FTS5 建立标题、URL 和正文索引。
3. 同一最终 URL 再次读取时更新正文、哈希和抓取时间，不产生重复文档。
4. `search_web` 根据 `source` 选择本地索引、SearXNG 或两者组合。

缓存命中也会补写索引，以便现有缓存数据在再次读取后自然迁移。本地索引与页面缓存共享同一
SQLite 文件，但使用独立表。

## 搜索接口

`SearchWebOptions` 新增：

- `source`: `auto`、`local` 或 `web`，默认 `auto`。

语义：

- `local`：只搜索本地 FTS5，支持 `limit` 和 `page`。
- `web`：只调用已配置的外部 Provider；未配置时返回
  `SEARCH_PROVIDER_NOT_CONFIGURED`。
- `auto`：第 1 页先搜索本地，再调用外部 Provider 补足 `limit`，并按规范化 URL 去重；
  后续页直接使用外部 Provider，避免两套分页产生重复和错位。
- `auto` 下外部 Provider 未配置时，如果本地库已有文档，则返回本地结果；如果本地库为空，
  返回 `SEARCH_PROVIDER_NOT_CONFIGURED`。
- `auto` 下已有本地命中而外部补足失败时，返回 `status: partial` 和结构化 warning；本地没有
  命中时继续原样抛出 Provider 错误。

`SearchResult` 新增 `source: local | web`。本地结果的 `engines` 为
`["diaoyan-local"]`，`score` 为 `null`，避免把 FTS 排名与外部 Provider 分数错误比较。

`SearchWebResult`：

- `status`: `ok | partial`。
- `provider`: `local`、外部 Provider 名称或 `local+<provider>`。
- `warnings`: 外部补足失败时包含稳定 code、message 和 retryable；其他成功结果为空数组。
- 混合结果的 `totalResults` 为 `null`，因为两套结果去重后无法可靠推导全量数量。

## 安全与失败边界

- SQL 查询继续使用参数绑定。
- 用户查询转换为字面量 FTS token，不允许直接注入 FTS5 操作符。
- 只索引已经通过 URL、robots、访问状态和内容完整性检查的成功页面。
- `authProfile !== null` 的页面绝不写入全文索引。
- 外部搜索失败不得静默伪装为完整成功。
- 本地索引初始化失败必须阻止应用启动，不得降级为无索引运行。

## 影响文件

- `src/index.ts`：SQLite FTS5 存储和查询。
- `src/reader.ts`、`src/app.ts`：成功读取后的索引写入和生命周期。
- `src/search.ts`、`src/types.ts`：搜索编排和返回契约。
- `src/mcp.ts`、`src/cli/main.ts`：暴露 `source` 参数。
- `tests/`：索引更新、授权隔离、本地搜索、混合去重和显式部分失败。
- `README.md`、`docs/spec.md`、`docs/roadmap.md`：使用说明和版本状态。

## 验收

- 读取公开页面后可在无 SearXNG 环境下用 `source=local` 找到。
- 重读同一最终 URL 后只保留最新版本。
- 授权 Profile 页面不会出现在本地搜索。
- 混合搜索本地优先、URL 去重并补足结果。
- 外部 Provider 补足失败时返回 `partial`，无本地结果时仍失败。
- 类型检查、构建和全部单元测试通过。
