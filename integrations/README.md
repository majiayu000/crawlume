# No-code integrations

Packages that expose the Crawlume Project Control API to workflow tools. Each is self-contained
(its own `package.json`, managed with `bun`) and is not part of the `crawlume` npm package.

| Directory | Tool | Status |
|---|---|---|
| [`n8n/`](n8n/) | n8n community node | Builds, lints, ran in a local n8n against a local control plane |
| [`zapier/`](zapier/) | Zapier Platform CLI app | Passes `zapier-platform validate`, live tests pass against a local control plane |
| [`make/`](make/) | Make custom app (local-development layout) | Passes Make's IML schemas; not yet run in Make |

All three use only routes in [`docs/project-control-api.openapi.yaml`](../docs/project-control-api.openapi.yaml):
Job create/get/cancel, publications, Artifact download, and webhook endpoints.

## API gaps found while building them

- **Crawl, map and search Jobs.** The schema lists them, but the control plane accepts only `read`
  (`No released Worker can execute crawl Jobs`). No integration offers "start crawl" until a Worker
  runs them.
- **No API-key route that just checks a key.** Every integration tests its connection by reading a
  Job that cannot exist and treating 404 as success. A `GET /projects/{id}` (or a whoami route)
  readable with `results:read` would replace that.
- **No list of Jobs or past webhook events.** Zapier's `performList` and the trigger samples in
  n8n and Make have to use fixed examples. `GET /projects/{id}/jobs` or a list of webhook events
  (with payloads) would give real samples and polling triggers.
- **Read results need cloud Artifact storage.** With `worker_local` Artifacts there is no route
  that returns the content, so "read a page" only works when S3 storage is configured.
- **Webhook endpoints need `project:admin`.** A trigger therefore needs an admin-scoped key. A
  narrower `webhooks:write` scope would let users keep automation keys smaller.
