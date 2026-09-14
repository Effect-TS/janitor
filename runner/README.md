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

The Cloudflare Worker is named `janitor-agent-runner`. The root Alchemy stack deploys it alongside Janitor in production at `https://runner.janitor.effectful.co`. Its dependency graph and build remain isolated. Alchemy runs `vp run build:deploy` in this directory, then uploads `dist/worker.mjs` with `bundle: false`.

Alchemy derives Janitor's production runner URL from the deployment domain. `JANITOR_AGENT_RUNNER_URL` is only a local-development override. Supply `JANITOR_AGENT_RUNNER_TOKEN` in `.env.production`; Alchemy binds the same secret to both Workers. The earlier `RUNNER_SERVICE_URL` and `RUNNER_SERVICE_TOKEN` names are no longer read.

| Binding                                     | Purpose                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `JANITOR_AGENT_RUNNER_TOKEN`                | Bearer token Janitor presents on every command.                                                                           |
| `JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS` | JSON `{ default, records[] }` of immutable model configuration records (`src/ModelConfiguration.ts`). No key values.      |
| `JANITOR_AGENT_RUNNER_RELEASE`              | Release identity recorded in each object's compatibility record.                                                          |
| `<record.secretBinding>`                    | One secret binding per provider credential, read at request time only. Rotate through deployment; records stay unchanged. |

A session selects the default record at creation and keeps it; changing the default affects new sessions only. A missing secret or retired record is a visible execution failure, never a substitute model.

See [deployment model validation](MODEL-VALIDATION.md) for the provider-backed configuration, local checks, bounded live check and rotation procedure.

Use `JANITOR_AGENT_RUNNER_MODEL_API_KEY` for the OpenRouter secret. Alchemy defaults model configurations to `model-configurations/openrouter-llama-3.1-8b.json`; `JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS` can override the JSON. Keep its credential bindings under `JANITOR_AGENT_RUNNER_MODEL_API_KEY`, or explicitly extend the stack's secret bindings for additional credentials. Alchemy derives `JANITOR_AGENT_RUNNER_RELEASE` from the built artifact hash.

Production setup requires `JANITOR_AGENT_RUNNER_TOKEN`, `REPOSITORY_SERVICE_TOKEN` and `JANITOR_AGENT_RUNNER_MODEL_API_KEY` in `.env.production`, in addition to the existing Janitor deployment credentials. Supply `JANITOR_MAINTENANCE_TOKEN` to enable controlled upgrades. From the repository root, run `vp run plan:prod`, inspect the plan, then `vp run deploy:prod`. Docker must be available for the container build, and the Cloudflare account must support Containers and R2. The deployment creates the checkpoint bucket, both SQLite Durable Object classes, the container application and image, and a private service binding to the actual Alchemy-managed backend. Worker and checkpoint storage use retention policies. Local `vp run dev` does not provision a paid runner.

For CI, add those three required secrets to GitHub's `production` environment. The deploy workflow forwards them explicitly and deploys on pushes to `main`. `JANITOR_MAINTENANCE_TOKEN` is an optional environment secret, and `JANITOR_AGENT_RUNNER_MODEL_CONFIGURATIONS` is an optional environment variable. Neither a runner URL nor a release identifier needs to be entered. The workflow also forwards the private Slack conversation settings separately from Slack sign-in settings.

Alchemy publishes the container before the final runner bundle is built. The deployment build inspects that immutable image, pulling it with a temporary Cloudflare registry credential on a fresh CI host when needed. It checks the bridge source identity, embeds the actual image digest and ID in the Worker, and writes the observed Node/package versions to `dist/image-provenance.json`. Generated metadata stays outside the image build context. CI preserves that file and `dist/release-manifest.json` as the `runner-deployment-evidence` artifact. The checked-in manifest remains the source contract for local tests; deployment replaces only its image identity with the published build's identity.

Production sandboxes use `standard-1` (1/2 vCPU, 4 GiB RAM, 8 GB disk), with at most ten instances. The implicit `lite` default is too small for the validated repository clone: on 2026-09-14, a public clone of `Effect-TS/effect` in the bridge image hit the 120-second deadline with 1/16 vCPU and 256 MiB RAM, but completed in 42 seconds with 1/2 vCPU and 4 GiB RAM. These are local Docker measurements, not a production latency guarantee. Larger instances increase container costs; see [Cloudflare pricing](https://developers.cloudflare.com/containers/platform/pricing/).

Changing the instance size does not reconcile clones already recorded as unfinished. Preserve those sessions and use a fresh Slack thread for the next deployment smoke test. Session creation can also exceed the backend's 20-second request timeout during a cold start; creation retries retain the same session identity.

## Command boundary

All routes require the bearer token and `x-janitor-runner-protocol: 2`.

| Route                                       | Command                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /v1/health`                            | Release identity, the pinned release manifest and any manifest problems.                  |
| `PUT /v1/sessions/:id`                      | Idempotent creation with a generation; the native conversation identity is deterministic. |
| `POST /v1/sessions/:id/inputs`              | Durable admission by stable `msg_` id; returns the existing or new receipt.               |
| `GET /v1/sessions/:id`                      | Inspection without constructing a host: execution state, reason, supervision, usage.      |
| `GET /v1/sessions/:id/events?after=&limit=` | Exclusive-cursor read of durable events plus replay-safe cumulative usage.                |
| `POST /v1/sessions/:id/maintenance`         | Operator hold/release by epoch; holds drain and quiesce, releases verify before lifting.  |
| `DELETE /v1/sessions/:id`                   | Generation-fenced cleanup leaving only a tombstone.                                       |

Errors carry `{ code, message, reason? }` with distinct codes: `unauthorized`, `incompatible_protocol` (426), `invalid_request`, `stale_generation` (409), `missing_session` (404), `blocked` (423) and `transport` (503, retryable with the same identities).

## Supervision

Admission persists the wake obligation and arms the alarm before native admission. The alarm rearms before fallible inspection, wakes pending native work, lets native recovery own orphaned claims with its ten-resumption accounting, and clears itself only after rechecking the supervision revision. Maintenance holds, compatibility guards (`_janitor_*` compatibility record, the native migration journal and the committed checkpoint manifest) and persisted blockers are checked before any host construction. The model transport applies the five-minute inactivity deadline at the HTTP boundary; native provider retries and Retry-After remain intact. The structured question tool is not advertised; commands must be foreground with a finite timeout.

## Deployment

`alchemy.run.ts` is the production deployment authority. `wrangler.jsonc` remains a reference for standalone packaging; do not use a second deployment tool to manage the Alchemy-owned Worker. An already independently deployed runner requires an explicit adoption/migration plan before switching its ownership to Alchemy.

## Release manifest and compatibility

`release-manifest.json` is the pinned record of what a runner build speaks, reads and requires, with each contract versioned on its own: the command protocol (`commandProtocol`), the native OpenCode migration set (`nativeMigrations`, with the pinned package, revision and every migration id), the Janitor-owned `_janitor_*` state format (`janitorState`, with the formats this release can read), the checkpoint manifest and archive formats (`checkpoint`), and the bridge protocol, required capabilities and image identity (`bridge`). It also pins the build identities: OpenCode and Effect versions, the Sandbox SDK, the Worker compatibility date and flags, and the bridge's base image, source hash, image digest and image ID. `family` names the state family this release writes and `readableFamilies` the families it has a tested path to read; that list is the only declared rollback path.

`src/ReleaseManifest.ts` checks the manifest against the compiled bundle and `test/ReleaseManifest.test.ts` checks it against `package.json`, `wrangler.jsonc`, `bridge/release.json`, `bridge/build.json`, the bridge's exported protocol and capabilities and the archive format. Disagreements are manifest `problems` on `GET /v1/health`; Janitor refuses to release maintenance against a runner that reports any. Changing a pinned dependency, the bridge sources or the Dockerfile means rebuilding and recording the image (`vp run build:bridge --record`) and updating the manifest deliberately.

The bridge image carries `bridge/build.json`, the SHA-256 of its source files written by `scripts/build-image.mjs`, and advertises it on `/meta`. Every repository dispatch and every maintenance release checks the running bridge's protocol, capabilities and source hash against the manifest, so a container still running an older image receives no tool work. Deployment success only says an image rollout started.

Each session's `_janitor_*` compatibility record (format 2) names the state family, protocol, release, the native migration ids recorded at the last completed initialization and any migration in progress. Before any SDK host is constructed the runner checks that record and the actual native migration journal: native state with no record, a newer migration id, an unreadable format, a family without a tested path, an initialization by another target that did not complete, or a committed checkpoint whose manifest is missing, foreign or unsupported all block the session with that reason and touch nothing. A fresh empty database initializes; a format 1 record and an older native set are upgraded forward under a persisted migration intent. Native migrations commit one step at a time, so a crash leaves a partially migrated database: the intent names the migration target and only the same target resumes it. Checkpoint pointers commit with a manifest (format, session, generation, repository, digest, size, key and operation) that restore validates first.

## Controlled upgrades

Routine compatible releases use ordinary restart recovery behind the same guards. A release that changes session storage or execution uses the maintenance barrier in Janitor, driven by deployment tooling through service-token routes (`JANITOR_MAINTENANCE_TOKEN` on the Janitor Worker; unset disables them):

1. `POST /api/v1/maintenance/hold` with `{ "reason", "expectedRelease" }` writes the barrier before any session is enumerated, then asks every session's runner to hold. Sessions started and inputs accepted afterwards are withheld from dispatch by the handoff; intake, authorization and deduplication keep running and inputs keep their acceptance order. The dashboard shows sessions blocked with the maintenance reason.
2. A runner persists its hold first, so alarms and restarts cannot resume work, then drains: an admitted foreground command finishes or reaches its finite timeout and commits its result and checkpoint together; no fresh model request or tool admission leaves the object; then the runtime is disposed as a shutdown, which keeps the native execution claim. A runner release re-checks its epoch and fence after its own checks and refuses while its drain is still running. `POST /api/v1/maintenance/advance` (also run by the agent catch-up cron) retries runners that did not answer and refreshes quiescence. A runner that cannot be reached is never counted as quiescent, and an acknowledgement for another epoch is stale. Wait for the barrier to report `held` before deploying anything incompatible; postpone the upgrade if it never does.
3. Deploy readers before writers, apply migrations and let the image rollout finish. `GET /api/v1/maintenance` reports the barrier and every session's hold state, uncertainty and last error.
4. `POST /api/v1/maintenance/release` with `{ "epoch" }` first verifies the deployed runner's `/v1/health`: no manifest problems, the protocol and event contract Janitor speaks, the state family Janitor is tested against and, when the hold named one, the expected release. It then refuses (409, naming the sessions) while any session, including one started since the last advance, has not acknowledged its hold or is not yet quiescent. Then each runner releases only the matching epoch after its own state, checkpoint, model credential and running bridge checks; a session whose checks fail stays held with the failing check recorded, while the rest resume through native recovery and re-requested delivery in the original order. Repeat the release after repair to reach what is still held. A session disconnected during the hold takes its hold with it: that fence outranks release.

Rollback is a deployment of a release whose manifest lists the current state family among `readableFamilies` and that was tested against the actual stored state and peers. Anything else must repair forward while affected sessions stay blocked: nothing rewinds inputs, publication receipts or whole-state snapshots automatically, and model records and current approved secrets are retained.

`test/Upgrade.test.ts` covers the health manifest, the compatibility record, partial and resumed migrations, family refusal, the format 1 upgrade and the hold's behaviour across restart, epochs, refused release and a missing credential. `test/MaintenanceRepository.test.ts` runs the hold against real foreground tool work in the built image, verifies the bridge on release, rejects an old image, and refuses foreign or unsupported checkpoint manifests before restore. Janitor's `test/Agent/Maintenance.test.ts` and the acceptance driver exercise the barrier, withheld intake, unreachable and stale runners, refused release and process replacement under a hold. These are local checks; no live cross-version deployment has been performed.

## Repository execution

Creation accepts an optional `repositoryId`, the numeric GitHub identity selected in Janitor. Selection is immutable. Janitor stores it on `agent_session` and includes it in the ordered creation handoff. Sessions without a selection have no tools. Selected sessions expose native `read`, `glob`, `grep`, `write`, `edit`, foreground `shell`, and Janitor's `publish` tool. The synthetic `execute` tool, structured questions, and direct session-shell/background entry points remain disabled.

The runner protocol is now **2**, including on the existing `/v1/` routes. An older runner must reject the new caller instead of silently dropping repository selection. Existing protocol-1 compatibility records remain held for the guarded upgrade procedure; this change does not rewrite them or reset sessions.

Provision `SANDBOXES` with the exported `Sandbox` class and a private `REPOSITORY_AUTHORITY` service binding to the stage's Janitor Worker. Set the same `REPOSITORY_SERVICE_TOKEN` secret on both Workers. The authority checks session generation, selected repository, connection, access and synchronization readiness on every request, including cache hits. It caches tokens by installation, numeric repository and permission set, refreshing within one minute of expiry or after invalidation. Clone and fetch use Contents read, push uses Contents write, and PR API calls use Contents read plus Pull requests write. The GitHub App installation must grant those permissions. Its private key stays in Janitor.

`RepositoryWorkspace` derives the resource name from the session, generation and repository, saves its identity before allocation, and adopts the existing bridge process on reconnect. It authenticates `containerFetch` requests on port 8788 and checks the running bridge's protocol, capabilities, generation and epoch before dispatch. No preview port or public bridge route is configured.

Runner SQLite saves immutable operation admission before dispatch. The bridge commits admission before spawn, records sequenced binary stdin and output, and contains each process in a PID namespace under a separate workspace user. This user cannot read the bridge process environment or write its journal. Lost responses retry the same identity within the same epoch. Changed epochs and unresolved admissions hold recovery for reconciliation. Bridge journals survive process restart; runner admission records survive container loss. Tool admission also precedes native execution. A tool result is released only after its workspace archive and saved result commit together in runner SQLite. A changed bridge epoch restores the last committed archive only when no operation is uncertain.

Clone credentials exist only in the controlled Git process environment. Credential helper configuration is per invocation, clone URLs contain no credentials, and clone output is discarded. The operation journal records repository identity and outcome without the token. Cleanup fences the workspace before container destruction and can retry after a failed destruction.

## New-work publication

After committing and testing changes, the agent calls `publish` with a title, a substantive body including validation, and an optional base branch. The default base comes from GitHub. The session, generation and repository determine one stable `janitor/<sha256>` branch. For new work, repeated calls after completion return the recorded PR.

A Slack start targeting an existing PR retains that PR as its review destination. The credential authority supplies its number, and the runner records its repository, head/base refs and commits before cloning. Each later publication turn updates the same branch and returns the same PR link. Publication rechecks the PR identity, incorporates human commits, and refuses branch replacement, force pushing and automatic merging. The bridge must advertise `existing-pr-v1`; rebuild and replace older bridge images before enabling this runner.

Fork PRs are checked out through the base repository's `refs/pull/<number>/head`. The base-repository token does not authorize pushing to the fork. Those edits remain in the workspace, with an explanation on the original PR when comment access is available. A separate proposal requires explicit teammate direction.

Conflicts and denied writes produce a durable PR comment intent. Lost comment responses are reconciled by marker, destination and `performed_via_github_app.id`, using `JANITOR_GITHUB_APP_ID` from the credential authority. Uncertain comments hold subsequent repository work until a `publish` retry confirms delivery. Definitively denied comments remain pending for retry. Missing markers never authorize a duplicate POST.

Publication stops workspace processes and copies regular Git object files into a private temporary repository. It ignores workspace Git config, hooks, replacement refs and alternates. Credentials reach only controlled network Git commands, and push uses an explicit repository URL and branch refspec without force. A private worktree merge supports the image's Git 2.34, incorporates fetched human commits, and reports conflicts without changing the agent's work. The designated local branch and merged commit are checkpointed before push.

Runner SQLite records the preparation identity and intended commit, head and base before remote writes. The bridge journals preparation receipts without credentials, allowing a lost response or interrupted checkpoint upload to recover the same result. Remote refs establish whether a push landed; matching PRs use a stable marker and numeric head/base repository identities. PR head SHA may lag the ref. An uncertain PR creation never triggers another POST. Pending publication blocks ordinary repository tools until reconciliation. Confirmed denied or invalid writes preserve work and permit a retry on the same branch.

The durable native tool result includes the PR association and summary. Slack consumes that result, saves `slack_thread.pr_number` and queues the summary and link even if the model never produces a final answer. Tool failures also reach the thread. Publication does not merge PRs.

The native publication test uses local Workerd, SQLite, R2 and the production bridge image with real Git repositories. It exercises divergent human commits on the pinned image, lost preparation/push/PR responses, checkpoint interruption, readiness loss, denied and invalid PR writes, credential exclusion and duplicate prevention. GitHub responses are controlled fixtures. Live GitHub permissions, branch protection and deployed service bindings require separate acceptance evidence.

`test/Publication.live.test.ts` is skipped by default. After authorization for bounded writes in `Effect-TS/slopcop-sandbox`, run it from `runner/` with these environment variables:

```sh
FIXTURE_ALLOW_PUBLICATION=Effect-TS/slopcop-sandbox \
FIXTURE_APP_ENV_FILE=/absolute/path/to/.env.production \
FIXTURE_REPORT_PATH=/absolute/path/to/publication-result.json \
vp run test test/Publication.live.test.ts
```

The environment file must contain `JANITOR_GITHUB_APP_ID` and `JANITOR_GITHUB_APP_PRIVATE_KEY`. The driver mints repository-scoped installation tokens, uses a scripted model with local durable execution and the production bridge, and permits one branch push and one PR creation. It discards successful push and PR responses, restarts the runner, and reconciles the existing PR. Cleanup stops execution, closes the PR without merging, deletes its branch, verifies the default branch, and revokes tokens. The evidence file records identities before writes and cleanup outcomes without credentials. Any unresolved cleanup must be reconciled using that file before another live run. This does not exercise deployed service bindings, production credential-authority readiness checks, or Slack delivery.

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

## Workspace checkpoints

Provision the private R2 binding `WORKSPACE_CHECKPOINTS` separately for each stage. The checked-in binding name is `janitor-workspace-checkpoints`; test runs use local Miniflare R2. No bucket is provisioned by local tests.

The runner serializes native repository tools. Shell commands receive a fixed public environment; Workerd process environment bindings and runner secrets are not forwarded. The bridge drops to a separate workspace user before starting the process namespace, then applies caller environment variables inside that namespace. Workspace commands cannot read the bridge's process environment or journal. Checkpoint Git index inspection disables repository hooks and uses a credential-free environment. Successful tools and failed commands both freeze the workspace, stop command descendants, transfer shell captures to `/workspace/.janitor-captures/`, upload an archive, and commit its pointer together with the tool result. Capture notices name these readable paths outside the Git repository. The bridge stays frozen if checkpointing fails. A retained tool admission blocks dependent work and native recovery until its outcome is reconciled; a new epoch never permits blind replay.

Archives use the versioned `janitor-workspace-2` format with a SHA-256 checksum. They preserve the Git directory, index, local commits, working tree, ignored data, file modes and relative symlinks within the workspace. Restore verifies the hash and validates all entries before replacing workspace contents from a clean staging directory. Untracked credential stores `.ssh`, `.aws`, `.git-credentials`, and `.env*` are excluded, as are untracked reproducible caches `node_modules`, `.cache`, `.pnpm-store`, and `.npm`. Tracked files and their parent directories are retained, including templates such as `.env.example`. Arbitrary file content is not scanned for secrets; controlled Git credentials never enter workspace files. Required ignored files are retained unless they match those explicit exclusions.

Archives stream in 64 KiB file chunks through the runner into R2 with a verified SHA-256 checksum. Restore streams to temporary disk storage and validates before replacing workspace contents. Archive size is not tied to Worker memory. The bridge's existing 8 MiB per-command output limit still applies. Unsupported special files, links escaping the workspace, extra descriptors, pipeline objects, inherited stdio, and alternate process-shell options fail explicitly. Ordinary shell pipelines and binary process streams are supported. Shell deadlines default to two minutes and permit explicit positive finite values.

Upload intents are durable before R2 writes. The previous archive stays referenced until replacement commit. Supervision prunes unreferenced objects using retained upload intents, including while execution is held; failed deletions remain retryable. Session cleanup deletes all archives and refuses to erase its cleanup records while an upload is still settling.

The local acceptance test runs native edits, failed and timed-out shell commands, large-output reads, two isolated sessions, Sandbox replacement, and runner crashes on each side of pointer commit. The bridge restoration test separately verifies staged and unstaged content, local Git commits, ignored data, binary bytes, modes, symlinks, hash rejection and capture-path protection. These checks use local containers, Workerd and R2, not a live Cloudflare deployment.
