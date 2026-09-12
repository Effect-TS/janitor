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

All routes require the bearer token and `x-janitor-runner-protocol: 2`.

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

## Repository inspection

Creation accepts an optional `repositoryId`, the numeric GitHub identity selected in Janitor. Selection is immutable. Janitor stores it on `agent_session` and includes it in the ordered creation handoff. Sessions without a selection have no tools. Selected sessions expose native `read`, `glob`, and `grep`; both shell and the SDK's synthetic `execute` tool are disabled.

The runner protocol is now **2**, including on the existing `/v1/` routes. An older runner must reject the new caller instead of silently dropping repository selection. Existing protocol-1 compatibility records remain held for the guarded upgrade procedure; this change does not rewrite them or reset sessions.

Provision `SANDBOXES` with the exported `Sandbox` class and a private `REPOSITORY_AUTHORITY` service binding to the stage's Janitor Worker. Set the same `REPOSITORY_SERVICE_TOKEN` secret on both Workers. The authority checks session generation, selected repository, connection, access and synchronization readiness. It issues a fresh token for one numeric repository with Contents read permission only. The GitHub App key stays in Janitor.

`RepositoryWorkspace` derives the resource name from the session, generation and repository, saves its identity before allocation, and adopts the existing bridge process on reconnect. It authenticates `containerFetch` requests on port 8788 and checks the running bridge's protocol, capabilities, generation and epoch before dispatch. No preview port or public bridge route is configured.

Runner SQLite saves immutable operation admission before dispatch. The bridge commits admission before spawn, records sequenced binary stdin and output, and contains each process in a PID namespace. Lost responses retry the same identity within the same epoch. Changed epochs and unresolved admissions hold recovery for reconciliation. Bridge journals survive process restart; runner admission records survive container loss. Workspace restoration and checkpoint commits belong to ticket 06.

Clone credentials exist only in the controlled Git process environment. Credential helper configuration is per invocation, clone URLs contain no credentials, and clone output is discarded. The operation journal records repository identity and outcome without the token. Cleanup fences the workspace before container destruction and can retry after a failed destruction.

## Repository checks and image provenance

Run commands from `runner/` through Vite+:

```sh
vp install
vp run typecheck
vp run test:bridge
vp run test
vp run build
vp run build:bridge --record
```

Runner tests build the local image and require Docker or a compatible Podman CLI. The repository acceptance driver supplies preloaded repositories and a controlled credential authority at service boundaries, then runs the production bridge image, runner SQLite and native tools. It covers two sessions, lost creation and process responses, stale generations, readiness, incompatible image capabilities and repeated cleanup. The bridge tests also clone through real Git against a local authenticated HTTP repository and check credential exclusion, binary stdin replay, output cursors and cancellation. These are local checks, not a deployed Cloudflare or live GitHub acceptance claim.

`bridge/release.json` records the built image manifest digest, image ID, base image, bridge/Sandbox versions and installed tools. `vp run build:bridge --record` deliberately updates that manifest for a release candidate. Publishing that exact image and binding production services remain deployment work. Changing the Dockerfile or bridge requires rebuilding and recording a new digest.
