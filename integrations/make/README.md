# Crawlume for Make

A Make custom app in the local-development layout used by Make's VS Code extension
([`integromat/vscode-apps-sdk`](https://github.com/integromat/vscode-apps-sdk)): `makecomapp.json`
plus one IML JSON file per component part. It is built on the Crawlume
[Project Control API](../../docs/project-control-api.openapi.yaml).

| Component | Type | What it does |
|---|---|---|
| `crawlume` | connection | Control Plane URL (with `/v1`), Project ID, API key; verified by a 404 on a Job that cannot exist |
| `readPage` | action | Creates a read Job, polls it (1 s, up to 150 times), downloads the first cloud Artifact, returns `title` and `markdown` |
| `startReadJob` | action | Queues a read Job |
| `getJob` | action | Returns a Job's status |
| `getJobResult` | action | Same polling and download as `readPage`, for an existing Job ID |
| `cancelJob` | action | Cancels an unfinished Job |
| `watchJobEvents` | instant trigger | Fires on Job webhooks through the `jobEvents` webhook |
| `jobEvents` | webhook (dedicated) | Attach registers `{{webhook.url}}` with `POST /webhook-endpoints`; detach disables it |

The `Authorization` header is set on each control-plane request, not in `base`. That way it is never
sent to the presigned S3 URL, which S3 would reject.

## Validate

```bash
bun install
bun run validate
```

`validate.mjs` checks `makecomapp.json` and every `*.iml.json` file against the JSON schemas Make's
extension applies to the same file names (pinned to extension commit `6ff5f3d`, downloaded at run
time). It also checks that every file is referenced from `makecomapp.json`. Make has no CLI
validator, so this is the closest local check available. It passes, and a deliberately broken file
fails it.

## Not verified

Schema validation checks structure, not runtime behaviour, and this app has not run in Make. These
spots need a check in Make's scenario editor:

- `{{uuid}}` as the idempotency key, `first(body.publications)`, and the `repeat` polling with
  `valid` turning a failed or cancelled Job into an error.
- The absolute `{{temp.downloadUrl}}` request bypassing `base.baseUrl`, and `type: json` parsing the
  Artifact (served as `application/vnd.diaoyan.public-read-result+json`).
- The connection treating the 404 probe as valid.
- Signature checks. The webhook does not verify `webhook-signature`, because IML has no clear way to
  do a keyed HMAC with a base64-decoded secret. Anyone who learns the Make webhook URL can post fake
  events. Treat events as hints and read the Job with `getJob` before acting on them.
- Webhook delivery at all. Crawlume only delivers to public `https` URLs, which Make's hook URLs are,
  but no end-to-end delivery was tested.

## Publish (needs your Make account)

1. In Make, create a custom app (Custom apps → Create app), or let the VS Code extension create it.
2. Install the *Make Apps Editor* extension, add your Make API token, and set `origins[0]` in
   `makecomapp.json`: `baseUrl` for your zone (e.g. `https://eu1.make.com/api`), the app's `appId`,
   and `apikeyFile` pointing at a file that holds the token. `.secrets/` is ignored by git here.
3. Right-click `makecomapp.json` → *Deploy to Make*, then test each module in a scenario.
4. To list the app publicly, request review from Make (Custom app → Publish → Request review).
