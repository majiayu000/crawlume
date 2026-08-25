# Search Provider Setup

Diaoyan does not scrape search-result HTML. When `DIAOYAN_LOCAL_INDEX_ENABLED=1`, it can search pages
already read into its local SQLite index without any external service. For discovery beyond that corpus, its first web provider
uses the [documented SearXNG JSON API](https://docs.searxng.org/dev/search_api.html).

## Configure SearXNG

Enable JSON output in the SearXNG `settings.yml`:

```yaml
search:
  formats:
    - html
    - json
```

Public instances frequently disable JSON. A local or organization-managed instance is the recommended configuration.

## Configure Diaoyan

Set the instance base URL. Localhost is supported because this value is controlled by the administrator rather than by an Agent tool argument.

```bash
export DIAOYAN_SEARXNG_URL=http://127.0.0.1:8080
export DIAOYAN_LOCAL_INDEX_ENABLED=1 # optional; disabled by default
```

For an MCP server:

```toml
[mcp_servers.diaoyan]
command = "node"
args = ["/Users/lifcc/Desktop/code/diaoyan/dist/server.js"]
env = { DIAOYAN_SEARXNG_URL = "http://127.0.0.1:8080", DIAOYAN_ALLOW_DNS_FAKE_IP = "1" }
```

## Search

```bash
diaoyan search MiniMax H3 推理优化 --language zh-CN --limit 10
diaoyan search recent browser agent releases --time-range month --safe-search 1
diaoyan crawl https://example.com/docs --max-pages 20
diaoyan search deployment guide --source local
```

MCP input:

```json
{
  "query": "MiniMax H3 推理优化",
  "limit": 10,
  "language": "zh-CN",
  "safeSearch": 1,
  "source": "auto"
}
```

Search sources:

- `auto` (default): local results first, then SearXNG fills the first page when configured.
- `local`: SQLite FTS5 only; no network search request.
- `web`: SearXNG only.

When local indexing is explicitly enabled, public successful reads and crawls are indexed
automatically. Reads using an authorization profile are intentionally excluded. Search returns normalized titles, URLs, snippets, source engines,
optional dates, and provider scores. The Agent should call `read_page` on web-discovered URLs before
relying on their contents.

If neither indexed pages nor a provider are available in `auto` mode, Diaoyan returns
`SEARCH_PROVIDER_NOT_CONFIGURED`. If JSON output is disabled or the provider response is invalid, it
returns `SEARCH_PROVIDER_ERROR`. When an external fill fails after local matches were found, the
result is explicitly marked `partial` with a warning.
