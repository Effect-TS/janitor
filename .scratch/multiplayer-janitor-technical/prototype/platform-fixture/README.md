# Platform delivery fixture

This is a disposable local contract model, not Janitor's integration implementation. It has no network calls and needs no platform credentials. See the [live fixture plan](../../research/platform-fixture-plan.md) for the checks it cannot establish.

From the repository root, with `vp` on PATH:

```sh
node .scratch/multiplayer-janitor-technical/prototype/platform-fixture/verify-local.mjs
```

The wrapper copies this isolated package to a temporary directory, runs its `verify` script through `vp run --no-cache verify`, and removes the copy even on failure. Set `JANITOR_VP_BIN` to the absolute Vite+ executable if necessary. Requires Node 24 for `node:sqlite`. No dependencies are installed. This package deliberately is not part of Janitor's production workspace.

The checks cover raw-byte signatures, logical input versus receipt deduplication, immutable acceptance/rejection under sequential membership changes, channel and thread boundaries, exclusion of non-original human messages, precision-safe Slack timestamps, context-boundary filtering, ambiguous publication policy, and progress coalescing.

Limits: SQLite is in memory. These tests do not simulate distributed authorization races, process crashes, raw Slack edit/delete envelope normalization, actual API pagination, platform rate limits, GitHub review grouping, durable output transport, or real bot membership. The history test filters combined synthetic pages; it does not call Slack. The rejection tests use already normalized events. Production normalization must keep mutation-event receipts separate from the identity and admission of the original message, so an edit/delete arriving first cannot poison the original decision. `reconcilePost` assumes the caller already authenticated and fully matched each marker; it tests the decision policy only. `outputPlan` assumes durable projection sequence order.

`slack-manifest.json` is a proposed disposable internal test app. Replace its URL only after the fixture receiver is prepared and deployment is authorized. Do not install it yet. It includes both mention and private-message events to exercise overlap. Metadata scope and subscriptions still need acceptance by the actual Slack installation. Identity linking is outside this fixture's scope.

## Create the Slack test app

The selected workspace is `effectfulworkspace.slack.com`; the private test channel is `janitor-test`. No app existed when the user supplied these destinations.

Run from the repository root:

```sh
bash .scratch/multiplayer-janitor-technical/prototype/platform-fixture/setup-slack.sh
```

The wizard walks through creating the app, installing it and collecting credentials, then adding it to the private channel. It stores `SLACK_APP_ID`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_WORKSPACE_DOMAIN`, `SLACK_CHANNEL_ID`, and `SLACK_CHANNEL_NAME` in `$HOME/.config/janitor/platform-fixture.env`, outside the repository, with mode 0600. Secret prompts hide their input. Do not paste the values into chat. The agent can derive the workspace ID through `auth.test`; the human need not find it manually.

Creation uses `slack-bootstrap-manifest.json`, which omits event subscriptions until a real receiver URL is available. `slack-manifest.json` remains the proposed full event configuration; do not paste its placeholder URL into Slack. The wizard performs no API calls, deployments, or message tests. The human controls app creation and installation in Slack. If workspace approval is required or Slack rejects a scope, report that error without secrets. The manifest has been parsed locally but has not yet been accepted by Slack.

The script passed `bash -n` and static review. Its wizard library is copied unchanged from the wizard skill template. It has not been run interactively by the agent. Shellcheck was unavailable.

Dashboard steps follow Slack's [manifest creation guide](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/), [app settings quickstart](https://docs.slack.dev/app-management/quickstart-app-settings/), and [guide to adding apps to channels](https://slack.com/help/articles/360001537467-Guide-to-apps-in-Slack). Client labels can vary between Agents & apps and Integrations.

## Receiver and first live checks

`inspect-slack.mjs` accepts `FIXTURE_SLACK_ENV_FILE` and optional `FIXTURE_REPORT_PATH`. It calls only read APIs and records capability facts without message contents. Run against the selected installation only.

`receiver.mjs` captures signed Slack callbacks in a SQLite Durable Object. `wrangler.json` pins the selected app, workspace, channel, and Cloudflare account. Deployment requires secrets `SLACK_SIGNING_SECRET` and `FIXTURE_CONTROL_TOKEN`; keep the bot token local. No receiver is deployed yet. The `/evidence`, `/events`, and `/faults` endpoints require the control token. Raw event export is private fixture data. Fault counters allow up to three failures before or after receipt persistence; they are zero by default. The receiver has no agent or outgoing message behavior.

Six local checks passed with Miniflare `5.20260911.0-alpha`, using its exported V4 configuration converter and V5 persistence root. Set `FIXTURE_MINIFLARE_MODULE` to the installed package's absolute `dist/src/index.js` path, then run:

```sh
node .scratch/multiplayer-janitor-technical/prototype/platform-fixture/verify-local.mjs verify-receiver
```

This uses local synthetic signing/control secrets and removes its temporary journal. It makes no Slack or Cloudflare API calls. `FIXTURE_MINIFLARE_MODULE` is a test dependency path, not a credential.

`probe-slack.mjs` is the first live API check, pending explicit authorization. It creates four bot messages in a single disposable thread, pages history, checks metadata markers, updates one message, then deletes known created messages. It requires `FIXTURE_ALLOW_POSTS=janitor-test`, `FIXTURE_SLACK_ENV_FILE`, and an absolute `FIXTURE_REPORT_PATH`. The file records intent before each POST. Uncertain publication is recorded and never blindly retried; unresolved cleanup needs reconciliation. Its simulated response loss discards the caller's return value only; it is not an actual network outage. The script has been syntax-checked, not live-verified. Run through the wrapper with task `live-slack` only after authorization. All message content is synthetic fixture text. Four posts plus one update fit the broader proposed mutation budget.

After an authorized deployment, set the Slack app's Event Subscriptions Request URL to the deployed Worker URL plus `/slack/events`, verify it, and enable the bot events in `slack-manifest.json`. The bootstrap app does not have those subscriptions yet. Do not enable the placeholder URL. Live receiver state will be removed with the disposable Worker/DO namespace after the integration tests finish.

`slack-human` replays the three human fixture messages through local admission and queries the real thread through its initiating timestamp. It is read-only remotely. It expects `FIXTURE_SLACK_ENV_FILE` and absolute `FIXTURE_REPORT_PATH`; its source pins this experiment's three message timestamps. It does not create or link a Janitor member. Saved evidence distinguishes remote observations from synthetic local eligibility and acceptance.

`github-reviews` runs the [bounded GitHub experiment](../../research/github-review-fixture-plan.md) only after explicit authorization. It requires `FIXTURE_ALLOW_GITHUB_REVIEWS=Effect-TS/slopcop-sandbox`, `FIXTURE_APP_ENV_FILE`, and absolute `FIXTURE_REPORT_PATH`, plus the existing `gh` login for `IMax153`. Run through the wrapper with task `github-reviews`. This driver posts as both the App and that human account; do not treat subscription setup as permission to run it. It has passed syntax checking only. Review/comment history remains on its closed draft PR after branch/token cleanup.

`github-capture` is a read-only recovery command for an existing fixture report. It needs `FIXTURE_APP_ENV_FILE`, `FIXTURE_RUN_PATH`, and `FIXTURE_REPORT_PATH`. It streams delivery pages, filters summaries before detail reads, and stops once all fixture-known expected events have been captured. This avoids the first driver's all-pages-first failure. It does not claim full-window production recovery. `github-json.mjs` preserves unsafe integer IDs from JSON source text; the current local implementation requires Node 24's source-text reviver.

`github-replay` uses `FIXTURE_RUN_PATH`, `FIXTURE_CAPTURE_PATH`, and `FIXTURE_REPORT_PATH` without remote calls. It checks candidate grouping against captured events in alternative orders, duplicate delivery, and missing-event cases. Known fixture snapshots stand in for successful hydration; the experiment does not guarantee historical snapshot availability in production.

## Final verification state, 2026-09-12

The authorized live runs are complete and the temporary receiver and namespace are deleted. Earlier setup descriptions above are historical. Slack Event Subscriptions still require manual disabling in the app dashboard. See the [verification handoff](../../research/platform-verification-summary.md) for results, cleanup, and remaining limits.

Additional wrapper tasks are `github-remaining` for pending-review membership and deleted targets, `slack-remaining` for deletion/history/ephemeral checks, `github-redelivery` for read-only capture of an already-requested redelivery and full-window listing, and `runtime-json` for the local Workerd parser check. The default local verification now includes the persistent delivery-queue policy tests. Remote mutation probes require their explicit fixture guards; running verification does not authorize new posts.
