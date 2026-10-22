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
- Prometheus `/metrics` endpoint behind `CRAWLUME_METRICS_PORT`, and JSON-line stderr logs for the MCP and control-plane server entrypoints.
- `crawlume backup` and `crawlume restore` CLI commands for verified SQLite backups.
- Operations manual (`docs/operations.md`).
- `pnpm bench:soak` soak/capacity runner and a manually triggered `Soak` workflow.

### Changed

- Minimum Node.js version lowered from 25.7 to 24.15 (LTS).

### Fixed

- Hybrid platform completion checklist now reflects what is implemented and tested.

- Test fixtures no longer use a fixed fetch date that expired under the cache TTL.

## [0.17.0]

- Baseline before this changelog; see [`docs/roadmap.md`](docs/roadmap.md) for v0.1–v0.17 history.
