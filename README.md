# Crawlume

Crawlume provides resumable web crawling and retrieval for AI agents. It is self-hosted and returns
explicit failures alongside source evidence. It discovers and crawls bounded sites, persists
asynchronous jobs, reads public pages with honest HTTP requests,
renders JavaScript pages with a real local Chrome browser when necessary, and can reuse a dedicated
user-authorized browser profile.

It does not impersonate AI crawlers, solve CAPTCHAs, or bypass login, payment, robots, or site access controls.

Deployment, configuration, backup and upgrade steps are in [`docs/operations.md`](docs/operations.md).
Architecture, reliability, benchmark, product, and implementation documents are indexed in
[`docs/README.md`](docs/README.md). The approved local modular Retrieval Runtime is implemented; its
public contract is [`docs/spec.md`](docs/spec.md), while conditional cluster, managed-provider, and
search-engine extensions remain separate future decisions.

## Requirements

- Node.js 24 LTS (24.15 or newer) or Node.js 26
- pnpm (version pinned by `packageManager` in `package.json`)
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
~/Library/Application Support/crawlume/
```

Set `CRAWLUME_DATA_DIR` to choose another location.

## Observability

Set `CRAWLUME_METRICS_PORT` to serve Prometheus counters at `GET /metrics` (bound to
`CRAWLUME_METRICS_HOST`, default `127.0.0.1`). The MCP and control-plane server entrypoints write
process event logs as JSON lines on stderr. MCP stdout stays reserved for JSON-RPC.

## Docker

The image bundles Chromium and stores runtime data in the `/data` volume:

```bash
docker build --tag crawlume .
docker run --rm -i --volume crawlume-data:/data crawlume
```

The default entrypoint serves MCP over stdio, so MCP clients can use `docker` as the command with
`run --rm -i --volume crawlume-data:/data crawlume` as arguments.

The control-plane HTTP API additionally needs PostgreSQL, an OIDC provider, two distinct Ed25519
signing key pairs, and a TLS certificate. Prepare `control-plane.env` with deployment-specific
values (the database hostname must be reachable from the container):

```dotenv
DIAOYAN_CONTROL_DATABASE_URL=postgresql://crawlume:password@db.example.com/crawlume
DIAOYAN_CONTROL_DATABASE_CA_PATH=/run/secrets/database-ca.pem
DIAOYAN_WORKER_SESSION_PRIVATE_KEY_PATH=/run/secrets/worker-private.pem
DIAOYAN_WORKER_SESSION_PUBLIC_KEY_PATH=/run/secrets/worker-public.pem
DIAOYAN_WORKER_SESSION_ISSUER=https://crawlume.example.com
DIAOYAN_WORKER_SESSION_AUDIENCE=crawlume-workers
DIAOYAN_HUMAN_ACCESS_TOKEN_PRIVATE_KEY_PATH=/run/secrets/human-private.pem
DIAOYAN_HUMAN_ACCESS_TOKEN_PUBLIC_KEY_PATH=/run/secrets/human-public.pem
DIAOYAN_HUMAN_ACCESS_TOKEN_ISSUER=https://crawlume.example.com
DIAOYAN_HUMAN_ACCESS_TOKEN_AUDIENCE=crawlume-api
DIAOYAN_OIDC_ISSUER=https://id.example.com
DIAOYAN_OIDC_AUTHORIZATION_ENDPOINT=https://id.example.com/authorize
DIAOYAN_OIDC_TOKEN_ENDPOINT=https://id.example.com/token
DIAOYAN_OIDC_CLIENT_ID=crawlume
DIAOYAN_OIDC_REDIRECT_URI=https://crawlume.example.com/v1/auth/oidc/callback
DIAOYAN_OIDC_ID_TOKEN_ALGORITHM=RS256
DIAOYAN_OIDC_JWKS_URI=https://id.example.com/.well-known/jwks.json
DIAOYAN_CONTROL_TLS_KEY_PATH=/run/secrets/tls-private.pem
DIAOYAN_CONTROL_TLS_CERT_PATH=/run/secrets/tls-cert.pem
```

Store the corresponding PEM files in `./secrets`. Private keys must be regular, non-symlink files
with owner-only permissions (`0600`), readable by the image's `node` user (UID 1000). Protect the
env file too. Use a certificate valid for the API hostname and register the exact redirect URI
with the OIDC provider. Then run:

```bash
docker run --rm --publish 127.0.0.1:8787:8787 \
  --env-file ./control-plane.env \
  --env DIAOYAN_CONTROL_HOST=0.0.0.0 --env DIAOYAN_CONTROL_PORT=8787 \
  --mount type=bind,src="$(pwd)/secrets",dst=/run/secrets,readonly \
  --volume crawlume-data:/data crawlume --control-plane
```

This binds TLS inside the container and publishes it only on the host loopback interface. Point
a host reverse proxy at `https://127.0.0.1:8787`, configure certificate verification for the API
hostname, and forward the public hostname's HTTPS traffic. Migrations run at startup.

## MCP configuration

Build the project, then add the server to an MCP client:

```toml
[mcp_servers.crawlume]
command = "node"
args = ["/absolute/path/to/crawlume/dist/server.js"]
disabled_tools = ["search_web", "get_search_status", "get_search_stats"]
env = { CRAWLUME_ALLOW_DNS_FAKE_IP = "1", CRAWLUME_LOCAL_INDEX_ENABLED = "0" }
```

`CRAWLUME_ALLOW_DNS_FAKE_IP` is only needed when local DNS runs in Fake-IP mode (for example
Clash/TUN). Omit it on systems whose DNS returns ordinary public addresses. This Codex
configuration focuses on reading supplied URLs and crawling sites; search tools are disabled.
Use an external search tool to find URLs. Local indexing remains off by default.

Available tools:

- `read_page`: return complete Markdown plus source evidence.
- `extract_page`: return structured JSON fields plus source evidence.
- `inspect_page`: run the same checks without returning the body.
- `map_site`: discover a bounded set of same-site links.
- `crawl_site`: read a bounded set of same-site pages with per-page evidence and failures.
- `start_crawl`: persist and start a bounded asynchronous crawl job.
- `get_crawl`: retrieve durable job progress, cumulative usage, budget, result, or failure.
- `get_crawl_pages`: read immutable page publications with a monotonic cursor, optionally waiting up
  to 30 seconds for the next publication without changing replay semantics.
- `pause_crawl` / `resume_crawl`: stop new page claims and continue from the SQLite frontier.
- `cancel_crawl`: abort active work and publish explicit stopped results for queued pages.
- `get_crawler_stats`: return local success, failure, cache, method, byte, retry, and duration aggregates.
- `start_monitor`: persist a single-page live monitor and establish its first content-hash baseline.
- `get_monitor`: return schedule, counters, hashes, and the last run or structured failure.
- `list_monitors`: list recent scheduled, running, and cancelled monitors.
- `cancel_monitor`: permanently stop a monitor and cooperatively cancel its current read.
- `list_auth_profiles`: list dedicated browser profile names.

Optional search tools (disabled in the configuration above):

- `search_web`: search the local page index, a configured SearXNG provider, or both.
- `get_search_status`: report configured local/web query backends without running a query.
- `get_search_stats`: report privacy-preserving observed query outcomes and latency percentiles.

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
setting it routes directly to the browser so an HTTP result cannot bypass the stated DOM condition.
Set `browserAllowed: false` to forbid browser execution. Exhausted time or interaction budgets fail
with `FETCH_TIMEOUT`.

```json
{
  "url": "https://example.com/infinite-feed",
  "browserReadiness": {
    "target": { "selector": "[data-terminal='true']", "state": "visible" },
    "interaction": { "type": "scroll-to-end", "maxSteps": 20, "stepDelayMs": 100 },
    "timeoutMs": 10000
  }
}
```

Successful reads include a zero-external-call, versioned validation result:

- `valid`: all required generic checks passed.
- `uncertain`: content is returnable, but at least one required dimension cannot be proved.
- `invalid`: never returns as a successful page; the planner may escalate once, then exposes a typed
  terminal error if no valid or uncertain candidate exists.

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
pnpm cli extract https://httpbin.org/html
pnpm cli read https://httpbin.org/html
pnpm cli read https://httpbin.org/html --markdown
pnpm cli read https://example.com/app --cache-mode live
pnpm cli read https://example.com/static --no-browser
pnpm cli map https://developer.mozilla.org/en-US/docs/Web/HTTP --max-pages 20 --max-depth 2
pnpm cli crawl https://developer.mozilla.org/en-US/docs/Web/HTTP --max-pages 5 --max-depth 1
CRAWLUME_SEARXNG_URL=http://127.0.0.1:8080 pnpm cli search MiniMax H3 推理优化 --language zh-CN
pnpm cli crawl https://example.com/docs --max-pages 20
pnpm cli search inference optimization --source local
pnpm cli stats --days 7
```

After installing or linking the package, use `crawlume search`, `crawlume read`, `crawlume extract`,
`crawlume map`, `crawlume crawl`, or `crawlume stats`.
JSON is the default output so scripts and Agents can inspect evidence and stable error codes;
`--markdown` prints only the extracted page body. Run `crawlume --help` for all options.

The crawler does not build a memory index by default. Set `CRAWLUME_LOCAL_INDEX_ENABLED=1` only when
you explicitly want successful public `read` and `crawl` results added to SQLite FTS5. With that
optional feature enabled, `--source auto` returns local matches first and asks SearXNG to fill the
remaining slots; `--source local` stays offline. Pages read with `--auth-profile` are never indexed.
The local projection has a 300,000-page hard limit and records distinct content-hash versions.

With the same flag enabled, `createApp(...).verticalSearch` exposes the local Phase 1 corpus control
surface: add official domains or exact manual URLs, discover SearXNG candidates, decide candidates,
start/refresh the bounded daily durable run, store query judgments, and evaluate Hit@10, Recall@10,
and MRR@10 against local-only results. The approved source policy, initial gold set, and
600-domain/60,000-attempt daily limits are documented in
[`docs/vertical-search-phase1-adr.md`](docs/vertical-search-phase1-adr.md).

The same local corpus now retains auditable URL identity observations and page history, can rebuild
the FTS projection offline from retained Raw/Artifact data, and prioritizes exact-URL recrawls by
observed change rate and staleness. `verticalSearch.runRetrievalExperiment(...)` records a paired
candidate-versus-lexical evaluation without changing production ranking. Search responses include
the sources actually executed and the pre-query local snapshot; MCP clients can call the read-only
`get_search_status` tool to distinguish a ready query backend from an unavailable one. See the
Phase 2–5 ADRs under [`docs/`](docs/README.md) for the exact boundaries. Phase 5 also adds
content-verifiable local releases with explicit activation/rollback and safe SQLite backup/restore
library boundaries; neither is exposed as an MCP mutation tool.

Synchronous `map` and `crawl` are same-host, serial, and bounded by default. Query parameters are removed
for deduplication unless `--keep-query` is supplied. Child-page failures are returned in a
`failures` array; a failed starting page fails the whole call.

For a long-running MCP server, use `start_crawl` when the Agent should not hold one tool call open.
It returns a UUID immediately and accepts `concurrency` from 1 to 32, a crawl-wide hard budget, and
up to 10,000 pages. Poll `get_crawl` for status and cumulative usage, and consume page results with
`get_crawl_pages`; cursors are stable across retries and restarts. `pause_crawl`, `resume_crawl`, and
`cancel_crawl` operate on the persisted page frontier. Jobs, origin cooldowns, leases, resource
reservations, and publications survive process restarts in `cache.sqlite`; committed pages are not
re-fetched after recovery. Normal CLI commands deliberately do not run the background queue, so a
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
  "authProfile": "research",
  "browserAllowed": true
}
```

## Reliability verification

The unified benchmark always uses the public Reader contract and writes gitignored, fingerprinted
reports. PR mode runs 46 controlled cases five times; Nightly adds 10 expiring public canaries.
Release comparison requires a baseline with the exact same versioned case set and repeat keys.

```bash
pnpm bench -- --mode pr
CRAWLUME_ALLOW_DNS_FAKE_IP=1 pnpm bench -- --mode nightly
pnpm bench:optimize
```

The Fake-IP prefix is only required on resolvers that map public hostnames to `198.18.0.0/15`.
Current repository evidence supports `canary-ready`; it does not claim private-release,
production-rollout, or competitor superiority evidence.

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `CRAWLUME_DATA_DIR` | platform user data directory | Cache and profiles |
| `CRAWLUME_USER_AGENT` | `Crawlume/0.10` | Honest crawler product name and operator contact |
| `CRAWLUME_AGENT_IDENTITY_URL` | unset | Public HTTPS identity used by Web Bot Auth |
| `CRAWLUME_WEB_BOT_AUTH_JWK_PATH` | unset | Absolute path to a mode-0600 Ed25519 private JWK; enables HTTP signing |
| `CRAWLUME_WEB_BOT_AUTH_PROFILE` | `cloudflare-legacy` | Wire compatibility profile; currently only this value is supported |
| `CRAWLUME_WEB_BOT_AUTH_TTL_SECONDS` | `60` | Signature lifetime from 10 to 300 seconds |
| `CRAWLUME_RSL_USAGE` | `ai-input` | Intended use: `ai-train`, `ai-input`, `ai-index`, or `search` |
| `CRAWLUME_RSL_USER_CLASS` | unset | Optional operator class used for RSL decisions |
| `CRAWLUME_RSL_GEO` | unset | Optional two-letter uppercase region used for RSL decisions |
| `CRAWLUME_RSL_APPROVALS_PATH` | `<data-dir>/rsl-approvals.json` | Absolute path to the administrator-managed approval file |
| `CRAWLUME_RSL_CLIENTS_PATH` | `<data-dir>/rsl-clients.json` | Absolute path to mode-0600 OLP client credentials |
| `CRAWLUME_REQUEST_TIMEOUT_MS` | `20000` | HTTP timeout |
| `CRAWLUME_BROWSER_TIMEOUT_MS` | `30000` | Browser navigation timeout |
| `CRAWLUME_MAX_RESPONSE_BYTES` | `5000000` | Maximum response size |
| `CRAWLUME_DEFAULT_CACHE_SECONDS` | `900` | Default successful-content TTL |
| `CRAWLUME_CRAWL_MAX_ATTEMPTS` | `3` | Maximum attempts per page; set 1 to disable retry |
| `CRAWLUME_CRAWL_RETRY_BASE_MS` | `500` | Exponential retry delay base |
| `CRAWLUME_CRAWL_MAX_RETRY_DELAY_MS` | `30000` | Maximum permitted retry or Retry-After wait |
| `CRAWLUME_CRAWL_MIN_HOST_INTERVAL_MS` | `250` | Minimum interval between attempts to one hostname |
| `CRAWLUME_CRAWL_WORKER_CONCURRENCY` | `8` | Global page-worker capacity across durable Crawl jobs |
| `CRAWLUME_CRAWL_LEASE_MS` | `5000` | Durable page lease duration; active workers heartbeat before expiry |
| `CRAWLUME_BROWSER_CHANNEL` | `chrome` | Playwright browser channel |
| `CRAWLUME_BROWSER_EXECUTABLE` | unset | Explicit browser executable path |
| `CRAWLUME_BROWSER_POOL_SIZE` | `2` | Maximum anonymous browser instances per process |
| `CRAWLUME_BROWSER_CONTEXTS_PER_INSTANCE` | `4` | Concurrent isolated contexts per pooled browser |
| `CRAWLUME_BROWSER_POOL_WAIT_MS` | `30000` | Maximum wait when browser capacity is full |
| `CRAWLUME_ALLOW_DNS_FAKE_IP` | `false` | Allow Clash/TUN DNS Fake-IP results for hostnames |
| `CRAWLUME_LOCAL_INDEX_ENABLED` | `false` | Optionally index successful public pages in SQLite FTS5 |
| `CRAWLUME_PROXY_URLS` | unset | Comma-separated administrator-controlled HTTP(S) proxy URLs |
| `CRAWLUME_SEARXNG_URL` | unset | Trusted SearXNG instance base URL used by `search_web` |

If Clash or another TUN resolver maps public domains into `198.18.0.0/15`, start the reader with
`CRAWLUME_ALLOW_DNS_FAKE_IP=1`. This applies only to DNS answers; a URL containing a literal
`198.18.x.x` address remains blocked by the SSRF policy.

Proxy example using operator-owned infrastructure:

```bash
export CRAWLUME_PROXY_URLS=http://proxy-a.internal:8080,https://user:password@proxy-b.internal:8443
```

Ordinary page attempts rotate through the pool. Authorization Profiles use a stable proxy selected
from their Profile name, including during `crawlume-auth`. Proxy routing does not bypass URL policy,
robots, authentication, payment, or access-denial checks.

### Self-owned Agent identity

Web Bot Auth is optional and disabled until an administrator provides both a public HTTPS identity
and an Ed25519 private JWK file. Use an identity you own; do not copy another crawler's User-Agent
or identity URL.

```bash
export CRAWLUME_USER_AGENT='Crawlume/0.10 (+https://crawler.example)'
export CRAWLUME_AGENT_IDENTITY_URL=https://crawler.example/identity
export CRAWLUME_WEB_BOT_AUTH_JWK_PATH=/absolute/private/path/crawlume-ed25519.jwk.json
chmod 600 "$CRAWLUME_WEB_BOT_AUTH_JWK_PATH"
pnpm start
```

The public origin must serve the matching public JWK at
`/.well-known/http-message-signatures-directory`, and each supporting platform may still require
separate bot registration. This release signs only direct HTTP fetches. Browser fetch evidence
reports `signed: false`; signing never bypasses robots, login, payment, or site policy. See the
[Agent identity specification](docs/agent-identity-spec.md) for the exact compatibility and key
requirements.

### RSL license policy

Crawlume checks RSL 1.0 declarations in applicable `robots.txt` groups, HTTP Link headers, HTML links,
and inline RSL scripts before extracted content is cached or returned to an Agent. The default
purpose is `ai-input`, matching grounding and RAG use. Configure user class or region only when the
operator can state those facts accurately:

```bash
export CRAWLUME_RSL_USAGE=ai-input
export CRAWLUME_RSL_USER_CLASS=personal
export CRAWLUME_RSL_GEO=CN
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
`settlementStatus: not-attempted`. Crawlume does not call a wallet, x402 facilitator, payment
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
access records with `crawlume rsl-audit --limit 100` or the read-only `get_rsl_audit` MCP tool.

For a free license that declares `<content server="https://licenses.example">`, configure the OLP
client issued by that server in a separate administrator-only file:

```json
{
  "version": 1,
  "clients": [{
    "server": "https://licenses.example",
    "clientId": "crawlume-client",
    "clientSecret": "replace-with-secret"
  }]
}
```

Save it at `CRAWLUME_RSL_CLIENTS_PATH`, set mode `0600`, and restart. Crawlume requests `/token`
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

## License

Apache-2.0. See [`LICENSE`](LICENSE).
