# n8n-nodes-crawlume

n8n community nodes for the Crawlume [Project Control API](../../docs/project-control-api.openapi.yaml).

- **Crawlume** (action): Read Page (create a read Job, wait, return Markdown), Start Read Job,
  Get Job, Get Job Results, Cancel Job. It is marked `usableAsTool`, so AI Agent nodes can call it.
- **Crawlume Trigger**: starts a workflow on `job.completed`, `job.failed` or `job.cancelled`
  webhooks and checks the Standard Webhooks signature the same way as `crawlume/sdk/webhooks`.

## Credentials

| Field | Value |
|---|---|
| Control Plane URL | e.g. `https://control.example/v1` (includes `/v1`) |
| Project ID | The Project the key belongs to |
| API Key | Project API key: `tasks:write` + `results:read`; the trigger also needs `project:admin` |

The credential test reads a Job that cannot exist. A 404 means the key works for this Project, and
401/403 return the control plane's own message.

## Behaviour

- Read Page polls once a second until the Job finishes, up to the Job deadline (default 120 s) plus
  30 s. It returns one item per published Artifact with `title`, `markdown`, `completeness` and the
  full `result`. A failed Job raises an error that includes its `error_code`. Use n8n's
  *Continue On Fail* to get it as an item instead.
- Content comes from cloud Artifacts, so the control plane needs `DIAOYAN_ARTIFACT_S3_BUCKET` and
  the Worker `CRAWLUME_WORKER_CLOUD_ARTIFACTS=1`. The presigned download URL must be reachable from n8n.
- Errors show the control plane's problem code and detail, e.g.
  `JOB_REQUEST_INVALID: input.input is invalid for the selected Job type.`
- Only `read` Jobs exist. The control plane rejects `crawl`, `map` and `search` today, so the node
  doesn't offer them.

### Trigger registration

- **Automatic** (default): activating the workflow calls `POST /webhook-endpoints` with the n8n
  production webhook URL and keeps the returned secret in the workflow's static data. Deactivating
  disables the endpoint. Crawlume only delivers to public `https` URLs, so n8n must be reachable at a
  public `N8N_WEBHOOK_URL`.
- **Manual**: register the endpoint yourself (API or SDK) and paste its `whsec_…` secret. You can
  list both secrets, separated by spaces, during a rotation.

Deliveries with a missing or bad signature, or a timestamp more than 5 minutes off, get a 401 and do
not start the workflow. Crawlume retries deliveries, so the same event `id` can arrive more than once.
Deduplicate on `id` if that matters.

## Develop

```bash
bun install
bun run build    # tsc + icons into dist/
bun run lint     # @n8n/eslint-plugin-community-nodes recommended rules
bun run test     # signature checks against src/sdk/webhooks.ts (run build first)
```

Install into a self-hosted n8n without publishing:

```bash
bun pm pack                                   # n8n-nodes-crawlume-0.1.0.tgz
cd ~/.n8n/nodes && npm install --omit=peer /path/to/n8n-nodes-crawlume-0.1.0.tgz
```

Then restart n8n.

## Verified locally

On n8n 2.47.5 in Docker, sharing the network namespace of the `deploy/compose` stack, with the
package installed as above:

- A workflow (Manual Trigger → Read Page → Get Job Results) read `https://www.iana.org/help/example-domains`
  through the control plane. Both nodes returned the title and 867 characters of Markdown.
- An invalid URL surfaced `JOB_REQUEST_INVALID: …` as the node error.
- The credential test (`POST /rest/credentials/test`) returned OK for the project key and the control
  plane's "invalid or no longer active" message for a bad key.
- With an active trigger in Manual mode, a delivery signed with the SDK's `signWebhook` started an
  execution that fetched the Job's Markdown. A delivery signed with another secret got a 401 and
  started nothing.

Not verified: automatic registration end to end. The control plane accepted the request shape, but
on the test host every hostname resolves to a Fake-IP (private) address, so it answered
`WEBHOOK_ENDPOINT_INVALID: The target resolves to a non-public address`. The browser fallback
(`Allow Browser`) was not exercised either.

## Publish (needs your accounts)

1. `npm login`, then `bun run build && npm publish` from this directory. The package name and the
   `n8n-community-node-package` keyword let self-hosted users install it from *Settings → Community Nodes*.
2. Optional, for n8n Cloud: submit the package in the n8n Creator Portal for verification. Verified
   nodes must pass the linter with no errors (light/dark icon variants are only warnings today) and
   should publish from CI with npm provenance.
