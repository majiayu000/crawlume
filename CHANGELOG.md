# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow Semantic Versioning.

## [Unreleased]

### Added

- Apache-2.0 license.
- GitHub Actions CI: typecheck, build and tests on Node 24 and 26, the PostgreSQL control-plane gate,
  and a Docker image build.
- Dockerfile with bundled Chromium and a `/data` runtime volume.
- Security policy.
- Control-plane `/healthz` and `/readyz` probes, a Compose healthcheck, and a Worker that waits for a ready Control Plane.
- Prometheus `/metrics` endpoint behind `CRAWLUME_METRICS_PORT`, and JSON-line stderr logs for the MCP and control-plane server entrypoints.
- `crawlume backup` and `crawlume restore` CLI commands for verified SQLite backups.
- Operations manual (`docs/operations.md`).
- `pnpm bench:soak` soak/capacity runner and a manually triggered `Soak` workflow.
- TypeScript SDK for the Project Control API (`crawlume/sdk`).
- Control-plane Project quotas (`DIAOYAN_QUOTA_*`) returning HTTP 429 `QUOTA_EXCEEDED`.
- `crawlume-worker` Remote Worker command (enroll/run) with durable outbox delivery, heartbeats, fenced-lease handling and optional cloud Artifact uploads.
- Control-plane Prometheus metrics from PostgreSQL state plus API request counters, 11 alert rules with promtool tests, and Prometheus in the Compose stack.
- Opt-in Artifact retention (`DIAOYAN_ARTIFACT_RETENTION_DAYS`): tombstone, then delete objects with retry.
- S3-compatible cloud Artifact storage: presigned, checksum-bound Worker uploads with HEAD verification and audited presigned downloads.
- Signed webhooks for terminal Job events with retries, dead letters, secret rotation and redelivery; `verifyWebhook` in `crawlume/sdk/webhooks`.

### Changed

- Minimum Node.js version lowered from 25.7 to 24.15 (LTS).

### Fixed

- Hybrid platform completion checklist now reflects what is implemented and tested.

- Test fixtures no longer use a fixed fetch date that expired under the cache TTL.
- `POST /jobs` returns 422 `JOB_REQUEST_INVALID` for Job types and non-public Jobs that no released Worker can execute, instead of accepting them and failing after a claim.
- `crawlume-worker enroll` declares `pdf` and `feed`, plus `browser` when `CRAWLUME_BROWSER_EXECUTABLE` exists; it no longer declares only `http`, which left such Jobs queued until their deadline.
- HTTP 404 and 410 now fail with `PAGE_NOT_FOUND` instead of `ACCESS_DENIED`, so a missing page is
  no longer reported as a policy stop.
- Pages served with HTTP 200 whose only prose says the item is missing ("No quotes found!",
  "No such item.", "This video isn't available") fail with `PAGE_NOT_FOUND` instead of succeeding.
- Shell detection measures visible text without inline scripts, so a page such as a YouTube watch
  page over HTTP, whose bootstrap data hid an empty body, is no longer accepted as content.
- `robots.txt` responses that are not rule documents (soft 404 HTML, JSON errors, challenge pages) now fail closed with `ROBOTS_UNAVAILABLE` instead of allowing every page.

## [0.17.0]

- Baseline before this changelog; see [`docs/roadmap.md`](docs/roadmap.md) for v0.1–v0.17 history.
