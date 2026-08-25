# Search Provider Setup

Diaoyan does not scrape search-result HTML. Its first search provider uses the [documented SearXNG JSON API](https://docs.searxng.org/dev/search_api.html), so a user or administrator must supply a trusted SearXNG instance.

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
```

MCP input:

```json
{
  "query": "MiniMax H3 推理优化",
  "limit": 10,
  "language": "zh-CN",
  "safeSearch": 1
}
```

Search returns normalized titles, URLs, snippets, source engines, optional dates, and provider scores. The Agent should call `read_page` on selected URLs before relying on their contents.

If no provider is configured, Diaoyan returns `SEARCH_PROVIDER_NOT_CONFIGURED`. If JSON output is disabled or the provider response is invalid, it returns `SEARCH_PROVIDER_ERROR`.
