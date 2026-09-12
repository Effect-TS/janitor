# Janitor agent runner

The runner is a separately built Cloudflare Worker with one SQLite Durable Object per agent session. Each object hosts the pinned OpenCode Workerd SDK (`@opencode/sdk/workerd/effect`, published packages `@opencode/*` 2.0.2) and owns the native conversation, inbox, execution claims, durable events and usage. Janitor talks to it only through the versioned JSON command boundary in `src/Protocol.ts`.

## Why a separate workspace

The published SDK depends on the registry Effect `4.0.0-rc.112` graph. Janitor's root workspace pins a pkg.pr.new Effect snapshot with global overrides, and the two graphs are not interchangeable. This directory is its own pnpm workspace (`pnpm-workspace.yaml`, `pnpm-lock.yaml`) so neither side's overrides can silently replace the other's dependencies. The root `vp` checks ignore this directory; run the runner's own checks from here.

## Setup

```sh
cd runner
pnpm install
```

The OpenCode packages are exact registry versions in `package.json`; upgrading them is a release decision (see the upgrade contract) because the native migration set and protocol may change.

## Checks

```sh
pnpm typecheck   # runner sources against the published declarations
pnpm build       # dist/worker.mjs, the deployable bundle
pnpm test        # builds dist-test/worker.mjs and runs the Miniflare scenarios
```

The test bundle (`test/worker.ts`) wraps the production runner with a scripted model transport and fault injection reachable only under `/__test/`. The production bundle contains none of it.

`scripts/serve.mjs [--test] [--port N] [--persist DIR]` serves a bundle through Miniflare and prints one JSON line with the URL and service token. Janitor's acceptance driver (`apps/cluster/test/Agent/AcceptanceDriver.test.ts`) uses it.

## Configuration

The Cloudflare Worker is named `janitor-agent-runner`. Use the `JANITOR_AGENT_RUNNER_` prefix for its deployment configuration so these settings are distinguishable from GitHub Actions runners.

Janitor needs `JANITOR_AGENT_RUNNER_URL`, the agent runner's HTTPS base URL, and `JANITOR_AGENT_RUNNER_TOKEN`. The same token is a secret binding on the agent runner. The earlier `RUNNER_SERVICE_URL` and `RUNNER_SERVICE_TOKEN` names are no longer read.

| Binding                                     | Purpose                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `JANITOR_AGENT_RUNNER_TOKEN`                | Bearer token Janitor presents on every command.                                                                           |
| `JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS` | JSON `{ default, records[] }` of immutable model configuration records (`src/ModelConfiguration.ts`). No key values.      |
| `JANITOR_AGENT_RUNNER_RELEASE`              | Release identity recorded in each object's compatibility record.                                                          |
| `<record.secretBinding>`                    | One secret binding per provider credential, read at request time only. Rotate through deployment; records stay unchanged. |

A session selects the default record at creation and keeps it; changing the default affects new sessions only. A missing secret or retired record is a visible execution failure, never a substitute model.

Use `JANITOR_AGENT_RUNNER_MODEL_API_KEY` for the provider secret and set the model record's `secretBinding` to that name. Other explicit binding names remain supported. In GitHub's `production` environment, store the URL and model configurations as variables, and the service token and provider key as secrets. Set `JANITOR_AGENT_RUNNER_RELEASE` from the deployed commit SHA. CI must explicitly pass each value to the corresponding deployment.

## Command boundary

All routes require the bearer token and `x-janitor-runner-protocol: 1`.

| Route                                       | Command                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `PUT /v1/sessions/:id`                      | Idempotent creation with a generation; the native conversation identity is deterministic. |
| `POST /v1/sessions/:id/inputs`              | Durable admission by stable `msg_` id; returns the existing or new receipt.               |
| `GET /v1/sessions/:id`                      | Inspection without constructing a host: execution state, reason, supervision, usage.      |
| `GET /v1/sessions/:id/events?after=&limit=` | Exclusive-cursor read of durable events plus replay-safe cumulative usage.                |
| `POST /v1/sessions/:id/maintenance`         | Operator hold/release by epoch; holds quiesce the host and preserve wake obligations.     |
| `DELETE /v1/sessions/:id`                   | Generation-fenced cleanup leaving only a tombstone.                                       |

Errors carry `{ code, message, reason? }` with distinct codes: `unauthorized`, `incompatible_protocol` (426), `invalid_request`, `stale_generation` (409), `missing_session` (404), `blocked` (423) and `transport` (503, retryable with the same identities).

## Supervision

Admission persists the wake obligation and arms the alarm before native admission. The alarm rearms before fallible inspection, wakes pending native work, lets native recovery own orphaned claims with its ten-resumption accounting, and clears itself only after rechecking the supervision revision. Maintenance holds, compatibility guards (`_janitor_*` compatibility record and the native migration journal) and persisted blockers are checked before any host construction. The model transport applies the five-minute inactivity deadline at the HTTP boundary; native provider retries and Retry-After remain intact. The structured question tool is not advertised; commands must be foreground with a finite timeout.

## Deployment

`wrangler.jsonc` packages `dist/worker.mjs` with the `SESSIONS` SQLite Durable Object class. Provisioning bindings and secrets per stage, and validating a real provider, belong to the deployment tickets; nothing here deploys.
