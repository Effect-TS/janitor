# Janitor session runner

The runner is a separately built Cloudflare Worker with one SQLite Durable Object per agent session. Each object hosts the pinned OpenCode Workerd SDK (`@opencode/sdk/workerd/effect` at revision `2df00955cb933e977427535d2505e50cbc689c69`) and owns the native conversation, inbox, execution claims, durable events and usage. Janitor talks to it only through the versioned JSON command boundary in `src/Protocol.ts`.

## Why a separate workspace

The pinned SDK was verified against the registry Effect `4.0.0-rc.112` graph. Janitor's root workspace pins a pkg.pr.new Effect snapshot with global overrides, and the two graphs are not interchangeable. This directory is its own pnpm workspace (`pnpm-workspace.yaml`, `pnpm-lock.yaml`) so neither side's overrides can silently replace the other's dependencies. The root `vp` checks ignore this directory; run the runner's own checks from here.

## Setup

```sh
cd runner
node scripts/vendor-opencode.mjs   # extracts the pinned OpenCode packages into vendor/
pnpm install
```

`vendor/` is not committed. `scripts/vendor-opencode.mjs` fetches the revision recorded in `opencode.json` (a blob-less clone, or `OPENCODE_SOURCE=/path/to/clone` to reuse a local checkout) and writes `vendor/SOURCE.json` with the extracted packages and a content hash. Upstream manifests lose scripts, devDependencies, optional UI peers and test directories; runtime source is unchanged.

## Checks

```sh
pnpm typecheck   # runner sources; upstream diagnostics under vendor/ are reported, not counted
pnpm build       # dist/worker.mjs, the deployable bundle
pnpm test        # builds dist-test/worker.mjs and runs the Miniflare scenarios
```

The test bundle (`test/worker.ts`) wraps the production runner with a scripted model transport and fault injection reachable only under `/__test/`. The production bundle contains none of it.

`scripts/serve.mjs [--test] [--port N] [--persist DIR]` serves a bundle through Miniflare and prints one JSON line with the URL and service token. Janitor's acceptance driver (`apps/cluster/test/Agent/AcceptanceDriver.test.ts`) uses it.

## Configuration

| Binding                       | Purpose                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `RUNNER_SERVICE_TOKEN`        | Bearer token Janitor presents on every command.                                                                           |
| `RUNNER_MODEL_CONFIGURATIONS` | JSON `{ default, records[] }` of immutable model configuration records (`src/ModelConfiguration.ts`). No key values.      |
| `RUNNER_RELEASE`              | Release identity recorded in each object's compatibility record.                                                          |
| `<record.secretBinding>`      | One secret binding per provider credential, read at request time only. Rotate through deployment; records stay unchanged. |

A session selects the default record at creation and keeps it; changing the default affects new sessions only. A missing secret or retired record is a visible execution failure, never a substitute model.

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
