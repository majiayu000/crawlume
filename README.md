# Diaoyan Crawler

Diaoyan is a self-hosted, fail-visible crawling gateway for long-running Agents. It discovers and
crawls bounded sites, persists asynchronous jobs, reads public pages with honest HTTP requests,
renders JavaScript pages with a real local Chrome browser when necessary, and can reuse a dedicated
user-authorized browser profile.

It does not impersonate AI crawlers, solve CAPTCHAs, or bypass login, payment, robots, or site access controls.

## Requirements

- Node.js 25.7 or newer
- pnpm
- Google Chrome for browser mode

## Install and verify

```bash
pnpm install
pnpm build
pnpm test
pnpm smoke
```

Runtime data is stored outside this repository. On macOS the default location is:

```text
~/Library/Application Support/diaoyan/
```

Set `DIAOYAN_DATA_DIR` to choose another location.

## MCP configuration

Build the project, then add the server to an MCP client:

```toml
[mcp_servers.diaoyan]
command = "node"
args = ["/Users/lifcc/Desktop/code/diaoyan/dist/server.js"]
env = { DIAOYAN_ALLOW_DNS_FAKE_IP = "1" }
```

The `env` line is needed on this machine because its Clash/TUN DNS uses Fake-IP mode. Omit it
on systems whose DNS returns ordinary public addresses.

Available tools:

- `search_web`: search the local page index, a configured SearXNG provider, or both.
- `read_page`: return complete Markdown plus source evidence.
- `inspect_page`: run the same checks without returning the body.
- `map_site`: discover a bounded set of same-site links.
- `crawl_site`: read a bounded set of same-site pages with per-page evidence and failures.
- `start_crawl`: persist and start a bounded asynchronous crawl job.
- `get_crawl`: retrieve durable job status, result, or failure.
- `cancel_crawl`: cancel a queued job or request cancellation of a running job.
- `list_auth_profiles`: list dedicated browser profile names.

Every blocked, authenticated, paid, challenged, unsupported, or incomplete response is returned as MCP `isError: true` with a stable error code.

Transient timeouts, 429 responses, and retryable upstream failures use bounded retries. Fresh result
evidence includes the actual attempt count and retry delay; access denial and other non-retryable
failures are attempted once.

Successful reads include a zero-external-call validation result:

- `usable`: no low-cost warning signal was found.
- `uncertain`: content is returnable but unusually short or required fallback document extraction.
- Rejected content remains a structured tool error and is never converted into a low score.

This validation does not use an LLM, embeddings, an extra request, or another browser pass.

## Command-line usage

Use the same reader directly without an MCP client:

```bash
pnpm cli -- read https://httpbin.org/html
pnpm cli -- read https://httpbin.org/html --markdown
pnpm cli -- read https://example.com/app --mode browser --cache-mode live
pnpm cli -- map https://developer.mozilla.org/en-US/docs/Web/HTTP --max-pages 20 --max-depth 2
pnpm cli -- crawl https://developer.mozilla.org/en-US/docs/Web/HTTP --max-pages 5 --max-depth 1
DIAOYAN_SEARXNG_URL=http://127.0.0.1:8080 pnpm cli -- search MiniMax H3 推理优化 --language zh-CN
pnpm cli -- crawl https://example.com/docs --max-pages 20
pnpm cli -- search inference optimization --source local
```

After installing or linking the package, use `diaoyan search`, `diaoyan read`, `diaoyan map`, or `diaoyan crawl`.
JSON is the default output so scripts and Agents can inspect evidence and stable error codes;
`--markdown` prints only the extracted page body. Run `diaoyan --help` for all options.

The crawler does not build a memory index by default. Set `DIAOYAN_LOCAL_INDEX_ENABLED=1` only when
you explicitly want successful public `read` and `crawl` results added to SQLite FTS5. With that
optional feature enabled, `--source auto` returns local matches first and asks SearXNG to fill the
remaining slots; `--source local` stays offline. Pages read with `--auth-profile` are never indexed.

`map` and `crawl` are same-host, serial, and bounded by default. Query parameters are removed
for deduplication unless `--keep-query` is supplied. Child-page failures are returned in a
`failures` array; a failed starting page fails the whole call.

For a long-running MCP server, use `start_crawl` when the Agent should not hold one tool call open.
It returns a UUID immediately; poll `get_crawl` at a task-appropriate interval and use
`cancel_crawl` when the result is no longer needed. Jobs and results survive process restarts in
`cache.sqlite`. Normal CLI commands deliberately do not run or recover the background queue, so a
single data directory should have one active MCP service process.

## Create an authorized browser profile

Use a dedicated profile rather than copying a personal Chrome profile:

```bash
pnpm auth -- --profile research --url https://example.com/login
```

Log in manually in the opened Chrome window and press Enter in the terminal. The profile remains outside the repository. An Agent can then call:

```json
{
  "url": "https://example.com/account/article",
  "mode": "browser",
  "authProfile": "research"
}
```

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `DIAOYAN_DATA_DIR` | platform user data directory | Cache and profiles |
| `DIAOYAN_REQUEST_TIMEOUT_MS` | `20000` | HTTP timeout |
| `DIAOYAN_BROWSER_TIMEOUT_MS` | `30000` | Browser navigation timeout |
| `DIAOYAN_MAX_RESPONSE_BYTES` | `5000000` | Maximum response size |
| `DIAOYAN_DEFAULT_CACHE_SECONDS` | `900` | Default successful-content TTL |
| `DIAOYAN_CRAWL_MAX_ATTEMPTS` | `3` | Maximum attempts per page; set 1 to disable retry |
| `DIAOYAN_CRAWL_RETRY_BASE_MS` | `500` | Exponential retry delay base |
| `DIAOYAN_CRAWL_MAX_RETRY_DELAY_MS` | `30000` | Maximum permitted retry or Retry-After wait |
| `DIAOYAN_CRAWL_MIN_HOST_INTERVAL_MS` | `250` | Minimum interval between attempts to one hostname |
| `DIAOYAN_BROWSER_CHANNEL` | `chrome` | Playwright browser channel |
| `DIAOYAN_BROWSER_EXECUTABLE` | unset | Explicit browser executable path |
| `DIAOYAN_ALLOW_DNS_FAKE_IP` | `false` | Allow Clash/TUN DNS Fake-IP results for hostnames |
| `DIAOYAN_LOCAL_INDEX_ENABLED` | `false` | Optionally index successful public pages in SQLite FTS5 |
| `DIAOYAN_SEARXNG_URL` | unset | Trusted SearXNG instance base URL used by `search_web` |

If Clash or another TUN resolver maps public domains into `198.18.0.0/15`, start the reader with
`DIAOYAN_ALLOW_DNS_FAKE_IP=1`. This applies only to DNS answers; a URL containing a literal
`198.18.x.x` address remains blocked by the SSRF policy.

Project documents:

- [Technical contract](docs/spec.md)
- [Competitive landscape](docs/competitive-landscape.md)
- [Product strategy](docs/product-strategy.md)
- [Roadmap](docs/roadmap.md)
- [Search provider setup](docs/search.md)
