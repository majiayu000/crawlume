# Crawlume for Zapier

A [Zapier Platform CLI](https://github.com/zapier/zapier-platform) app (platform 19.3.0) built on the
Crawlume [Project Control API](../../docs/project-control-api.openapi.yaml).

| Kind | Key | What it does |
|---|---|---|
| Action | `read_page` | Creates a read Job, waits up to 25 s, returns `title` and `markdown` |
| Action | `start_read_job` | Queues a read Job and returns it |
| Action | `cancel_job` | Cancels an unfinished Job |
| Search | `find_job` | Returns a Job; once completed, its Markdown |
| Trigger | `job_finished` | REST hook on `job.completed` / `job.failed` / `job.cancelled` |

Authentication is custom: Control Plane URL (with `/v1`), Project ID and API key. The connection test
reads a Job that cannot exist and treats 404 as success. The API key is only attached to
control-plane URLs, never to the presigned Artifact download.

Zapier stops actions after 30 seconds, so `read_page` gives the Job a 25-second deadline. For slow
pages, use `start_read_job` and later `find_job`, or trigger on `job_finished`.

The trigger subscribes with `POST /webhook-endpoints` and keeps the returned secret in
`subscribeData`. It verifies the Standard Webhooks signature on every delivery (same scheme as
`crawlume/sdk/webhooks`). Zapier deduplicates on the event `id`, so retried deliveries collapse.

## Develop

```bash
bun install
bun run validate   # zapier-platform validate --without-style (local schema checks)
bun run test       # node --test; live tests need the env vars below
```

The live tests call a real control plane through Zapier's `createAppTester`:

```bash
CRAWLUME_CONTROL_URL=https://127.0.0.1:8787/v1 CRAWLUME_PROJECT_ID=… CRAWLUME_API_KEY=… bun run test
```

## Verified locally

- `zapier-platform validate --without-style`: "No structural errors found".
- The four tests passed against the `deploy/compose` control plane (run inside its network namespace,
  so the presigned S3 URL was reachable):
  - the auth test accepts the key and rejects a bad one;
  - `read_page` returned Markdown, and `find_job` returned the same Markdown;
  - `start_read_job` and `cancel_job` worked, and an invalid URL surfaced `JOB_REQUEST_INVALID`;
  - the trigger's `perform` accepted a signed delivery and rejected a tampered body.

Not verified:

- `performSubscribe` against a live endpoint, for the same Fake-IP DNS reason as the n8n trigger.
- That Zapier's `bundle.rawRequest` carries the headers as `Http-Webhook-*`. The verifier accepts
  both that form and plain names, but only a deployed app shows which one Zapier really sends.
- `performList` returns a fixed sample, because no API route lists past events or Jobs. Zapier's
  publishing review may ask for real samples.

## Publish (needs your Zapier account)

1. `bunx zapier-platform login`
2. `bunx zapier-platform register "Crawlume"`. This writes `.zapierapprc`; commit it or keep it private.
3. `bunx zapier-platform push` deploys a private version. Test it in the Zap editor against a
   publicly reachable control plane.
4. `bunx zapier-platform validate` without `--without-style` runs Zapier's server-side style checks.
5. Invite testers (`zapier-platform users:add`), then submit for public listing from the developer
   platform UI.
