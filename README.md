# Diaoyan Crawler

Diaoyan is a self-hosted, fail-visible crawling gateway for long-running Agents. It discovers and
crawls bounded sites, persists asynchronous jobs, reads public pages with honest HTTP requests,
renders JavaScript pages with a real local Chrome browser when necessary, and can reuse a dedicated
user-authorized browser profile.

It does not impersonate AI crawlers, solve CAPTCHAs, or bypass login, payment, robots, or site access controls.

Architecture, reliability, benchmark, product, and implementation documents are indexed in
[`docs/README.md`](docs/README.md). Target architecture documents describe planned work; the current
implemented contract remains [`docs/spec.md`](docs/spec.md).

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
- `get_crawler_stats`: return local success, failure, cache, method, byte, retry, and duration aggregates.
- `start_monitor`: persist a single-page live monitor and establish its first content-hash baseline.
- `get_monitor`: return schedule, counters, hashes, and the last run or structured failure.
- `list_monitors`: list recent scheduled, running, and cancelled monitors.
- `cancel_monitor`: permanently stop a monitor and cooperatively cancel its current read.
- `list_auth_profiles`: list dedicated browser profile names.

Every blocked, authenticated, paid, challenged, unsupported, or incomplete response is returned as MCP `isError: true` with a stable error code.

Transient timeouts, 429 responses, and retryable upstream failures use bounded retries. Fresh result
evidence includes the actual attempt count and retry delay; access denial and other non-retryable
failures are attempted once.

Operators can optionally route HTTP and browser traffic through a self-hosted or existing HTTP(S)
proxy pool. Proxy addresses and credentials are configuration-only and never returned to Agents;
fresh result evidence exposes only `proxyUsed: true|false`.

Anonymous JavaScript pages reuse a bounded pool of Chrome instances while receiving a fresh isolated
BrowserContext per page. Authorization Profiles remain outside the pool and retain exclusive
persistent contexts.

Browser reads use conservative body stability by default. A caller that knows a page's terminal DOM
condition can provide `browserReadiness` to `read_page`, `inspect_page`, `crawl_site`, or
`start_crawl`. The policy requires a CSS target and may declare bounded `scroll-to-end` interaction;
setting it in `auto` mode routes directly to the browser so an HTTP result cannot bypass the stated
DOM condition. Exhausted time or interaction budgets fail with `FETCH_TIMEOUT`.

```json
{
  "url": "https://example.com/infinite-feed",
  "mode": "auto",
  "browserReadiness": {
    "target": { "selector": "[data-terminal='true']", "state": "visible" },
    "interaction": { "type": "scroll-to-end", "maxSteps": 20, "stepDelayMs": 100 },
    "timeoutMs": 10000
  }
}
```

Successful reads include a zero-external-call validation result:

- `usable`: no low-cost warning signal was found.
- `uncertain`: content is returnable but unusually short or required fallback document extraction.
- Rejected content remains a structured tool error and is never converted into a low score.

This validation does not use an LLM, embeddings, an extra request, or another browser pass.

Crawler statistics are also computed locally without storing URLs, hostnames, page content, search
queries, proxy addresses, or Authorization Profile names. They measure observable resource proxies
instead of inventing a monetary cost.

Page monitors force a live read, reuse the extracted SHA-256 content hash, and schedule the next run
from the previous completion time. The first success establishes a baseline; later runs report
`changed: true|false`. Failures remain explicit and do not erase the last successful baseline.

## Command-line usage

Use the same reader directly without an MCP client:

```bash
pnpm cli read https://httpbin.org/html
pnpm cli read https://httpbin.org/html --markdown
pnpm cli read https://example.com/app --mode browser --cache-mode live
pnpm cli map https://developer.mozilla.org/en-US/docs/Web/HTTP --max-pages 20 --max-depth 2
pnpm cli crawl https://developer.mozilla.org/en-US/docs/Web/HTTP --max-pages 5 --max-depth 1
DIAOYAN_SEARXNG_URL=http://127.0.0.1:8080 pnpm cli search MiniMax H3 推理优化 --language zh-CN
pnpm cli crawl https://example.com/docs --max-pages 20
pnpm cli search inference optimization --source local
pnpm cli stats --days 7
```

After installing or linking the package, use `diaoyan search`, `diaoyan read`, `diaoyan map`,
`diaoyan crawl`, or `diaoyan stats`.
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

For continuing change detection, call `start_monitor` with one public URL and an interval from 60
seconds to 7 days. The MCP service runs it immediately and persists future schedules in
`cache.sqlite`. Use `get_monitor` or `list_monitors` to observe changes and `cancel_monitor` to stop
it permanently. Monitor runs never expand to linked pages and never use cached content.

## Create an authorized browser profile

Use a dedicated profile rather than copying a personal Chrome profile:

```bash
pnpm auth --profile research --url https://example.com/login
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
| `DIAOYAN_USER_AGENT` | `DiaoyanWebReader/0.10` | Honest crawler product name and operator contact |
| `DIAOYAN_AGENT_IDENTITY_URL` | unset | Public HTTPS identity used by Web Bot Auth |
| `DIAOYAN_WEB_BOT_AUTH_JWK_PATH` | unset | Absolute path to a mode-0600 Ed25519 private JWK; enables HTTP signing |
| `DIAOYAN_WEB_BOT_AUTH_PROFILE` | `cloudflare-legacy` | Wire compatibility profile; currently only this value is supported |
| `DIAOYAN_WEB_BOT_AUTH_TTL_SECONDS` | `60` | Signature lifetime from 10 to 300 seconds |
| `DIAOYAN_RSL_USAGE` | `ai-input` | Intended use: `ai-train`, `ai-input`, `ai-index`, or `search` |
| `DIAOYAN_RSL_USER_CLASS` | unset | Optional operator class used for RSL decisions |
| `DIAOYAN_RSL_GEO` | unset | Optional two-letter uppercase region used for RSL decisions |
| `DIAOYAN_RSL_APPROVALS_PATH` | `<data-dir>/rsl-approvals.json` | Absolute path to the administrator-managed approval file |
| `DIAOYAN_RSL_CLIENTS_PATH` | `<data-dir>/rsl-clients.json` | Absolute path to mode-0600 OLP client credentials |
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
| `DIAOYAN_BROWSER_POOL_SIZE` | `2` | Maximum anonymous browser instances per process |
| `DIAOYAN_BROWSER_CONTEXTS_PER_INSTANCE` | `4` | Concurrent isolated contexts per pooled browser |
| `DIAOYAN_BROWSER_POOL_WAIT_MS` | `30000` | Maximum wait when browser capacity is full |
| `DIAOYAN_ALLOW_DNS_FAKE_IP` | `false` | Allow Clash/TUN DNS Fake-IP results for hostnames |
| `DIAOYAN_LOCAL_INDEX_ENABLED` | `false` | Optionally index successful public pages in SQLite FTS5 |
| `DIAOYAN_PROXY_URLS` | unset | Comma-separated administrator-controlled HTTP(S) proxy URLs |
| `DIAOYAN_SEARXNG_URL` | unset | Trusted SearXNG instance base URL used by `search_web` |

If Clash or another TUN resolver maps public domains into `198.18.0.0/15`, start the reader with
`DIAOYAN_ALLOW_DNS_FAKE_IP=1`. This applies only to DNS answers; a URL containing a literal
`198.18.x.x` address remains blocked by the SSRF policy.

Proxy example using operator-owned infrastructure:

```bash
export DIAOYAN_PROXY_URLS=http://proxy-a.internal:8080,https://user:password@proxy-b.internal:8443
```

Ordinary page attempts rotate through the pool. Authorization Profiles use a stable proxy selected
from their Profile name, including during `diaoyan-auth`. Proxy routing does not bypass URL policy,
robots, authentication, payment, or access-denial checks.

### Self-owned Agent identity

Web Bot Auth is optional and disabled until an administrator provides both a public HTTPS identity
and an Ed25519 private JWK file. Use an identity you own; do not copy another crawler's User-Agent
or identity URL.

```bash
export DIAOYAN_USER_AGENT='DiaoyanCrawler/0.10 (+https://crawler.example)'
export DIAOYAN_AGENT_IDENTITY_URL=https://crawler.example/identity
export DIAOYAN_WEB_BOT_AUTH_JWK_PATH=/absolute/private/path/diaoyan-ed25519.jwk.json
chmod 600 "$DIAOYAN_WEB_BOT_AUTH_JWK_PATH"
pnpm start
```

The public origin must serve the matching public JWK at
`/.well-known/http-message-signatures-directory`, and each supporting platform may still require
separate bot registration. This release signs only direct HTTP fetches. Browser fetch evidence
reports `signed: false`; signing never bypasses robots, login, payment, or site policy. See the
[Agent identity specification](docs/agent-identity-spec.md) for the exact compatibility and key
requirements.

### RSL license policy

Diaoyan checks RSL 1.0 declarations in applicable `robots.txt` groups, HTTP Link headers, HTML links,
and inline RSL scripts before extracted content is cached or returned to an Agent. The default
purpose is `ai-input`, matching grounding and RAG use. Configure user class or region only when the
operator can state those facts accurately:

```bash
export DIAOYAN_RSL_USAGE=ai-input
export DIAOYAN_RSL_USER_CLASS=personal
export DIAOYAN_RSL_GEO=CN
```

Clearly free and permitted content continues. A free License Server declaration can use OLP/CAP only
when the administrator has configured an exact client. Prohibited use, payment, unapproved
attribution, reporting, or legal terms fail with dedicated `RSL_*` error codes. This release never
purchases a license automatically. `not-declared` evidence means only that no supported RSL
association was found; it is not a legal clearance. See the
[RSL policy specification](docs/rsl-policy-spec.md) for supported discovery surfaces and limits.

Paid declarations return `RSL_PAYMENT_REQUIRED` with a bounded quote: payment type, static amount
and currency when declared, accepted protocol media types, and whether pricing is declared or
runtime-authoritative. The access audit records the same quote with `budgetStatus: disabled` and
`settlementStatus: not-attempted`. Diaoyan does not call a wallet, x402 facilitator, payment
provider, or custom licensing endpoint. See the
[RSL payment boundary specification](docs/rsl-payment-boundary-spec.md).

Static approvals can acknowledge attribution, standard-license, legal, or supplemental-term
obligations only when the exact license Hash, resource, runtime context, obligations, and expiry all
match. The file is administrator-managed and is never written through MCP or the ordinary CLI:

```json
{
  "version": 1,
  "approvals": [{
    "licenseHash": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "resource": "/articles/",
    "usage": "ai-input",
    "userClass": "personal",
    "geo": "CN",
    "obligations": ["attribution"],
    "expiresAt": "2026-12-31T15:59:59.000Z",
    "approvedBy": "operator@example.com"
  }]
}
```

Set the file to mode `0600` on POSIX systems and restart the service after editing it. Approvals do
not bypass prohibitions, payment, reporting, or License Token requirements. Inspect the latest safe
access records with `diaoyan rsl-audit --limit 100` or the read-only `get_rsl_audit` MCP tool.

For a free license that declares `<content server="https://licenses.example">`, configure the OLP
client issued by that server in a separate administrator-only file:

```json
{
  "version": 1,
  "clients": [{
    "server": "https://licenses.example",
    "clientId": "diaoyan-client",
    "clientSecret": "replace-with-secret"
  }]
}
```

Save it at `DIAOYAN_RSL_CLIENTS_PATH`, set mode `0600`, and restart. Diaoyan requests `/token`
directly over HTTPS, keeps the opaque Token in process memory only, and sends it only as a CAP
header for a matching main-document request. Token requests do not use the page proxy and never
follow redirects. Paid, reporting, registration, introspection, and EMS flows remain blocked or out
of scope; see the [OLP/CAP specification](docs/rsl-olp-cap-spec.md).

Project documents:

- [Technical contract](docs/spec.md)
- [Competitive landscape](docs/competitive-landscape.md)
- [Product strategy](docs/product-strategy.md)
- [Roadmap](docs/roadmap.md)
- [Search provider setup](docs/search.md)
- [Agent identity and Web Bot Auth](docs/agent-identity-spec.md)
- [RSL discovery and policy](docs/rsl-policy-spec.md)
- [RSL approvals and access audit](docs/rsl-approval-audit-spec.md)
- [RSL OLP Token and CAP authorization](docs/rsl-olp-cap-spec.md)
- [RSL paid-license quote boundary](docs/rsl-payment-boundary-spec.md)
